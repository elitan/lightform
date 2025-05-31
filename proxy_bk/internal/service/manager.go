package service

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/elitan/luma-proxy/internal/config"
	"github.com/elitan/luma-proxy/pkg/models"
)

// Manager handles service registration and lookup
type Manager struct {
	config *config.ProxyConfig
}

// NewManager creates a new service manager
func NewManager(cfg *config.ProxyConfig) *Manager {
	return &Manager{
		config: cfg,
	}
}

// FindByHost returns a service by its hostname
func (m *Manager) FindByHost(hostname string) (models.Service, bool) {
	return m.findByHostWithReload(hostname, true)
}

// findByHostWithReload returns a service by its hostname with optional configuration reload
func (m *Manager) findByHostWithReload(hostname string, shouldReload bool) (models.Service, bool) {
	// Only reload configuration if requested and the config file exists (production mode)
	// In tests, we work with in-memory configuration
	if shouldReload {
		if _, err := os.Stat("/tmp/luma-proxy-config.json"); err == nil {
			m.reloadConfiguration()
		}
	}

	m.config.RLock()
	defer m.config.RUnlock()

	for _, service := range m.config.Services {
		if service.Host == hostname {
			return service, true
		}
	}

	return models.Service{}, false
}

// Deploy configures routing for a hostname to a network alias target
func (m *Manager) Deploy(host, target, project string) error {
	return m.DeployWithHealthPath(host, target, project, "/up")
}

// DeployWithHealthPath configures routing for a hostname with custom health check path
func (m *Manager) DeployWithHealthPath(host, target, project, healthPath string) error {
	m.config.Lock()

	// Check for conflicts with other projects
	for _, service := range m.config.Services {
		if service.Host == host && service.Project != project {
			m.config.Unlock()
			return fmt.Errorf("host %s is already used in project %s",
				host, service.Project)
		}
	}

	// Set default health path if empty
	if healthPath == "" {
		healthPath = "/up"
	}

	// Create service - all targets are network aliases for zero-downtime deployments
	service := models.Service{
		Name:       host,
		Host:       host,
		Target:     target, // Always network alias:port (e.g., "blog:3000")
		Project:    project,
		Healthy:    true, // Assume healthy until proven otherwise
		HealthPath: healthPath,
	}

	m.config.Services[host] = service
	m.config.Unlock()

	return m.config.Save()
}

// UpdateServiceHealth updates the health status of a service
func (m *Manager) UpdateServiceHealth(hostname string, healthy bool) error {
	m.config.Lock()

	service, exists := m.config.Services[hostname]
	if !exists {
		m.config.Unlock()
		return fmt.Errorf("service not found: %s", hostname)
	}

	service.Healthy = healthy
	m.config.Services[hostname] = service
	m.config.Unlock()

	return m.config.Save()
}

// PerformHealthChecks checks health of all services
func (m *Manager) PerformHealthChecks() {
	services := m.GetAllServices()

	for _, service := range services {
		healthy := m.checkServiceHealthForService(service)
		if err := m.UpdateServiceHealth(service.Host, healthy); err != nil {
			log.Printf("Failed to update health for %s: %v", service.Host, err)
		}
	}
}

// checkServiceHealthForService performs HTTP health check on a specific service using project-scoped network resolution
func (m *Manager) checkServiceHealthForService(service models.Service) bool {
	log.Printf("Performing project-scoped health check for %s (project: %s) at %s%s",
		service.Host, service.Project, service.Target, service.HealthPath)

	// Use project-specific helper container to avoid multi-network DNS conflicts
	targetURL := fmt.Sprintf("http://%s%s", service.Target, service.HealthPath)

	// Option 1: Use project-specific helper container for network-isolated health checks
	helperName := fmt.Sprintf("luma-hc-helper-%s", service.Project)
	networkName := fmt.Sprintf("%s-network", service.Project)

	// Check if helper container exists, create if needed
	checkHelperCmd := exec.Command("docker", "ps", "-q", "--filter", fmt.Sprintf("name=%s", helperName))
	helperOutput, _ := checkHelperCmd.CombinedOutput()

	if len(strings.TrimSpace(string(helperOutput))) == 0 {
		// Create helper container connected only to the specific project network
		log.Printf("Creating project-specific health check helper for project %s", service.Project)
		createHelperCmd := exec.Command("docker", "run", "-d", "--name", helperName,
			"--network", networkName,
			"--restart", "unless-stopped",
			"alpine:latest", "sh", "-c", "apk add --no-cache curl && sleep 36000")

		if err := createHelperCmd.Run(); err != nil {
			log.Printf("Failed to create helper container for project %s: %v", service.Project, err)
			// Fallback to direct IP resolution
			return m.checkServiceHealthWithIPResolution(service)
		}

		// Wait for curl installation
		time.Sleep(3 * time.Second)
	}

	// Execute health check using project-specific helper container
	// This ensures DNS resolution happens within the correct project network
	cmd := exec.Command("docker", "exec", helperName,
		"curl", "-s", "-f", "--max-time", "5", "--connect-timeout", "3", targetURL)

	output, err := cmd.CombinedOutput()

	if err != nil {
		log.Printf("Project-scoped health check failed for %s (project: %s, target: %s): %v - output: %s",
			service.Host, service.Project, service.Target, err, string(output))
		return false
	}

	log.Printf("Project-scoped health check succeeded for %s (project: %s, target: %s)",
		service.Host, service.Project, service.Target)
	return true
}

// checkServiceHealthWithIPResolution is a fallback that resolves IPs directly within project context
func (m *Manager) checkServiceHealthWithIPResolution(service models.Service) bool {
	log.Printf("Using IP resolution fallback for %s (project: %s)", service.Host, service.Project)

	// Extract service name and port from target (e.g., "web:3000" -> "web", "3000")
	parts := strings.Split(service.Target, ":")
	if len(parts) != 2 {
		log.Printf("Invalid target format %s for service %s", service.Target, service.Host)
		return false
	}

	serviceName := parts[0]
	port := parts[1]
	networkName := fmt.Sprintf("%s-network", service.Project)

	// Find containers with the service alias in the specific project network
	inspectCmd := exec.Command("docker", "network", "inspect", networkName, "--format",
		fmt.Sprintf("{{range .Containers}}{{if eq .Name \"%s\"}}{{.IPv4Address}}{{end}}{{end}}",
			fmt.Sprintf("%s-%s-", service.Project, serviceName)))

	inspectOutput, err := inspectCmd.CombinedOutput()
	if err != nil {
		log.Printf("Failed to inspect network %s: %v", networkName, err)
		return false
	}

	// Parse IP addresses and try health check
	ips := strings.Fields(strings.TrimSpace(string(inspectOutput)))
	if len(ips) == 0 {
		log.Printf("No containers found for service %s in project %s", serviceName, service.Project)
		return false
	}

	// Try health check against first available IP
	for _, ipCIDR := range ips {
		ip := strings.Split(ipCIDR, "/")[0] // Remove CIDR notation
		targetURL := fmt.Sprintf("http://%s:%s%s", ip, port, service.HealthPath)

		cmd := exec.Command("docker", "exec", "luma-proxy",
			"curl", "-s", "-f", "--max-time", "5", "--connect-timeout", "3", targetURL)

		if err := cmd.Run(); err == nil {
			log.Printf("IP-based health check succeeded for %s at %s", service.Host, targetURL)
			return true
		}
	}

	return false
}

// checkServiceHealth performs HTTP health check on a service target (DEPRECATED - use checkServiceHealthForService)
func (m *Manager) checkServiceHealth(target string) bool {
	// Find the service to get its health path and project
	m.config.RLock()
	var service models.Service
	var found bool

	for _, svc := range m.config.Services {
		if svc.Target == target {
			service = svc
			found = true
			break
		}
	}
	m.config.RUnlock()

	if !found {
		log.Printf("Service not found for target %s", target)
		return false
	}

	return m.checkServiceHealthForService(service)
}

// StartHealthCheckRoutine starts a background routine for health checking
func (m *Manager) StartHealthCheckRoutine() {
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				// Reload configuration before performing health checks
				// This ensures we stay in sync with any manual configuration updates
				m.reloadConfiguration()
				m.PerformHealthChecks()
			}
		}
	}()
}

// reloadConfiguration reloads the configuration from the file to stay in sync
func (m *Manager) reloadConfiguration() {
	// Create a new config instance and load from file
	newConfig := config.New()
	newConfig.Load()

	// Update our manager's config reference
	m.config.Lock()

	// Copy services from the loaded config
	m.config.Services = make(map[string]models.Service)
	for key, service := range newConfig.Services {
		m.config.Services[key] = service
	}

	// Copy certificate config
	m.config.Certs = newConfig.Certs

	m.config.Unlock()
}

// GetAllServices returns all registered services
func (m *Manager) GetAllServices() []models.Service {
	m.config.RLock()
	defer m.config.RUnlock()

	services := make([]models.Service, 0, len(m.config.Services))
	for _, service := range m.config.Services {
		services = append(services, service)
	}

	return services
}

// RegisterService registers a new service with the manager
func (m *Manager) RegisterService(service models.Service) error {
	log.Printf("Registering service %s for host %s", service.Name, service.Host)

	m.config.Lock()
	m.config.Services[service.Name] = service
	m.config.Unlock()

	if err := m.config.Save(); err != nil {
		log.Printf("Error saving configuration: %v", err)
		return err
	}

	return nil
}

// RemoveService removes a service by name
func (m *Manager) RemoveService(name string) {
	m.config.Lock()
	delete(m.config.Services, name)
	m.config.Unlock()

	if err := m.config.Save(); err != nil {
		log.Printf("Error saving configuration after removing service: %v", err)
	}
}

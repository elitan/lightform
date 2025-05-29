package service

import (
	"encoding/json"
	"fmt"
	"log"
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
		healthy := m.checkServiceHealth(service.Target)
		if err := m.UpdateServiceHealth(service.Host, healthy); err != nil {
			log.Printf("Failed to update health for %s: %v", service.Host, err)
		}
	}
}

// checkServiceHealth performs HTTP health check on a service target
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

	log.Printf("Performing direct health check for %s (project: %s) at %s%s",
		service.Host, service.Project, service.Target, service.HealthPath)

	// Resolve the backend IP directly using Docker network inspection
	resolvedTarget, err := m.resolveBackendIP(service)
	if err != nil {
		log.Printf("Health check failed - could not resolve backend for %s in project %s: %v",
			service.Target, service.Project, err)
		return false
	}

	// Build the direct URL to check using resolved IP
	targetURL := fmt.Sprintf("http://%s%s", resolvedTarget, service.HealthPath)

	// Execute curl command directly to check service health
	cmd := exec.Command("curl", "-s", "-f", "--max-time", "5", "--connect-timeout", "3", targetURL)
	output, err := cmd.CombinedOutput()

	if err != nil {
		log.Printf("Health check failed for %s (project: %s, resolved: %s): %v - output: %s",
			service.Host, service.Project, resolvedTarget, err, string(output))
		return false
	}

	log.Printf("Health check succeeded for %s (project: %s, resolved: %s)",
		service.Host, service.Project, resolvedTarget)
	return true
}

// resolveBackendIP resolves the IP address of a backend service within its project network
func (m *Manager) resolveBackendIP(service models.Service) (string, error) {
	// Parse the target to extract hostname and port
	parts := strings.Split(service.Target, ":")
	if len(parts) != 2 {
		return "", fmt.Errorf("invalid target format: %s (expected hostname:port)", service.Target)
	}

	hostname := parts[0]
	port := parts[1]

	// Get the project network name
	projectNetworkName := fmt.Sprintf("%s-network", service.Project)

	// Inspect the project network to find containers with the hostname alias
	cmd := exec.Command("docker", "network", "inspect", projectNetworkName)
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to inspect network %s: %v", projectNetworkName, err)
	}

	var networks []NetworkInspectResult
	if err := json.Unmarshal(output, &networks); err != nil {
		return "", fmt.Errorf("failed to parse network inspect result: %v", err)
	}

	if len(networks) == 0 {
		return "", fmt.Errorf("network %s not found", projectNetworkName)
	}

	network := networks[0]

	// Find containers in this network and check which ones have the hostname alias
	for containerID, containerInfo := range network.Containers {
		// Get the container's aliases in this network
		aliasCmd := exec.Command("docker", "inspect", containerID,
			"--format", fmt.Sprintf("{{range $net, $conf := .NetworkSettings.Networks}}{{if eq $net \"%s\"}}{{range $conf.Aliases}}{{.}} {{end}}{{end}}{{end}}", projectNetworkName))
		aliasOutput, err := aliasCmd.Output()
		if err != nil {
			continue
		}

		aliases := strings.Fields(strings.TrimSpace(string(aliasOutput)))
		for _, alias := range aliases {
			if alias == hostname {
				// This container has the hostname alias, use its IP
				// Extract just the IP address (remove /subnet if present)
				ipAddr := strings.Split(containerInfo.IPv4Address, "/")[0]
				resolvedTarget := fmt.Sprintf("%s:%s", ipAddr, port)
				log.Printf("Resolved %s in project %s to %s (container: %s)", service.Target, service.Project, resolvedTarget, containerInfo.Name)
				return resolvedTarget, nil
			}
		}
	}

	return "", fmt.Errorf("no container found with alias %s in network %s", hostname, projectNetworkName)
}

type NetworkContainerInfo struct {
	Name        string `json:"Name"`
	IPv4Address string `json:"IPv4Address"`
}

type NetworkInspectResult struct {
	Containers map[string]NetworkContainerInfo `json:"Containers"`
}

// StartHealthCheckRoutine starts a background routine for health checking
func (m *Manager) StartHealthCheckRoutine() {
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				m.PerformHealthChecks()
			}
		}
	}()
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

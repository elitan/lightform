package service

import (
	"fmt"
	"log"
	"os"
	"os/exec"
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

// checkServiceHealthForService performs HTTP health check on a specific service using network-scoped DNS
func (m *Manager) checkServiceHealthForService(service models.Service) bool {
	log.Printf("Performing network-scoped health check for %s (project: %s) at %s%s",
		service.Host, service.Project, service.Target, service.HealthPath)

	// Use Docker exec to perform health check from within the proxy container
	// This leverages Docker's network-scoped DNS resolution within the project network
	targetURL := fmt.Sprintf("http://%s%s", service.Target, service.HealthPath)

	// Execute curl command from within the luma-proxy container
	// The proxy container is connected to all project networks, so DNS resolution
	// will automatically resolve within the correct project network context
	cmd := exec.Command("docker", "exec", "luma-proxy",
		"curl", "-s", "-f", "--max-time", "5", "--connect-timeout", "3", targetURL)

	output, err := cmd.CombinedOutput()

	if err != nil {
		log.Printf("Network-scoped health check failed for %s (project: %s, target: %s): %v - output: %s",
			service.Host, service.Project, service.Target, err, string(output))
		return false
	}

	log.Printf("Network-scoped health check succeeded for %s (project: %s, target: %s)",
		service.Host, service.Project, service.Target)
	return true
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

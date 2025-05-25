package service

import (
	"context"
	"fmt"
	"log"
	"net/http"
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
	m.config.Lock()
	defer m.config.Unlock()

	// Check for conflicts with other projects
	for _, service := range m.config.Services {
		if service.Host == host && service.Project != project {
			return fmt.Errorf("host %s is already used in project %s",
				host, service.Project)
		}
	}

	// Create service - all targets are network aliases for zero-downtime deployments
	service := models.Service{
		Name:    host,
		Host:    host,
		Target:  target, // Always network alias:port (e.g., "blog:3000")
		Project: project,
		Healthy: true, // Assume healthy until proven otherwise
	}

	m.config.Services[host] = service
	return m.config.Save()
}

// UpdateServiceHealth updates the health status of a service
func (m *Manager) UpdateServiceHealth(hostname string, healthy bool) error {
	m.config.Lock()
	defer m.config.Unlock()

	service, exists := m.config.Services[hostname]
	if !exists {
		return fmt.Errorf("service not found: %s", hostname)
	}

	service.Healthy = healthy
	m.config.Services[hostname] = service
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
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	url := fmt.Sprintf("http://%s/up", target)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return false
	}

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	return resp.StatusCode == http.StatusOK
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

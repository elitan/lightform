package service

import (
	"fmt"
	"log"

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

// Deploy configures routing for a hostname to a specific target
func (m *Manager) Deploy(host, target, project string) error {
	m.config.Lock()

	for _, service := range m.config.Services {
		if service.Host == host && service.Project != project {
			m.config.Unlock()
			return fmt.Errorf("host %s is already used in project %s",
				host, service.Project)
		}
	}

	m.config.Services[host] = models.Service{
		Name:    host,
		Host:    host,
		Target:  target,
		Project: project,
	}

	m.config.Unlock()

	return m.config.Save()
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

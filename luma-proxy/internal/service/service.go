package service

import (
	"fmt"

	"github.com/elitan/luma-proxy/internal/config"
	"github.com/elitan/luma-proxy/pkg/models"
)

// Manager handles service operations
type Manager struct {
	config *config.ProxyConfig
}

// NewManager creates a new service manager
func NewManager(config *config.ProxyConfig) *Manager {
	return &Manager{
		config: config,
	}
}

// Deploy configures routing for a hostname to a specific target
func (m *Manager) Deploy(host, target, project string) error {
	// Use exported methods from config to lock/unlock
	m.config.Lock()
	defer m.config.Unlock()

	// Check if the host is already used by another service from a different project
	for _, service := range m.config.Services {
		if service.Host == host && service.Project != project {
			return fmt.Errorf("host %s is already used in project %s",
				host, service.Project)
		}
	}

	// Use the host as the key in our services map
	// This naturally ensures uniqueness per host
	m.config.Services[host] = models.Service{
		Name:    host, // Set name to host for simplicity
		Host:    host,
		Target:  target,
		Project: project,
	}

	// Save the updated configuration
	return m.config.Save()
}

// FindByHost returns a service that serves the specified host
func (m *Manager) FindByHost(host string) (models.Service, bool) {
	// Use exported methods from config to lock/unlock
	m.config.RLock()
	defer m.config.RUnlock()

	service, exists := m.config.Services[host]
	if exists {
		return service, true
	}

	// Fallback: check all services if we don't have an exact match
	for _, service := range m.config.Services {
		if service.Host == host {
			return service, true
		}
	}

	return models.Service{}, false
}

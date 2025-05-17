package cloudflare

import (
	"context"
	"log"
	"sync"

	"luma/types"
)

// Manager handles domain management for projects
type Manager struct {
	client   *Client
	enabled  bool
	domains  map[string]types.ProjectDomain // hostname -> domain
	mu       sync.RWMutex
	autoGen  bool
}

// NewManager creates a new domain manager
func NewManager(client *Client, autoGenerate bool) *Manager {
	return &Manager{
		client:  client,
		enabled: client != nil,
		domains: make(map[string]types.ProjectDomain),
		autoGen: autoGenerate,
	}
}

// RegisterProjectDomain creates a new domain for a project
func (m *Manager) RegisterProjectDomain(ctx context.Context, project types.Project) (*types.ProjectDomain, error) {
	if !m.enabled || !m.autoGen {
		log.Printf("CloudflareManager: Domain registration skipped for project '%s' (enabled=%v, autoGen=%v)", 
			project.Name, m.enabled, m.autoGen)
		return nil, nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Check if domain already exists for this project
	if domain, exists := m.domains[project.Hostname]; exists {
		log.Printf("CloudflareManager: Domain already exists for project '%s': %s", project.Name, domain.Domain)
		return &domain, nil
	}

	// Create domain via Cloudflare client
	domain, err := m.client.CreateDomain(ctx, project)
	if err != nil {
		log.Printf("CloudflareManager: Failed to create domain for project '%s': %v", project.Name, err)
		return nil, err
	}

	// Store domain mapping
	m.domains[project.Hostname] = *domain
	log.Printf("CloudflareManager: Registered domain for project '%s': %s", project.Name, domain.Domain)

	return domain, nil
}

// GetProjectDomain retrieves domain info for a project
func (m *Manager) GetProjectDomain(hostname string) (types.ProjectDomain, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	domain, exists := m.domains[hostname]
	return domain, exists
}

// DeleteProjectDomain removes a domain for a project
func (m *Manager) DeleteProjectDomain(ctx context.Context, hostname string) error {
	if !m.enabled {
		return nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.domains[hostname]; !exists {
		return nil // Nothing to delete
	}

	if err := m.client.DeleteDomain(ctx, hostname); err != nil {
		log.Printf("CloudflareManager: Failed to delete domain for hostname '%s': %v", hostname, err)
		return err
	}

	delete(m.domains, hostname)
	log.Printf("CloudflareManager: Deleted domain for hostname '%s'", hostname)

	return nil
}

// GetAllDomains returns all registered domains
func (m *Manager) GetAllDomains() []types.ProjectDomain {
	m.mu.RLock()
	defer m.mu.RUnlock()

	domains := make([]types.ProjectDomain, 0, len(m.domains))
	for _, domain := range m.domains {
		domains = append(domains, domain)
	}
	return domains
}

// IsEnabled returns whether domain management is enabled
func (m *Manager) IsEnabled() bool {
	return m.enabled && m.client != nil
}
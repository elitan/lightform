package storage

import (
	"fmt"
	"sync"

	"github.com/elitan/lightform/proxy/internal/core"
)

// MemoryStore is a simple in-memory deployment store
type MemoryStore struct {
	mu          sync.RWMutex
	deployments map[string]*core.Deployment
}

// NewMemoryStore creates a new in-memory store
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		deployments: make(map[string]*core.Deployment),
	}
}

// GetDeployment retrieves a deployment by hostname
func (s *MemoryStore) GetDeployment(hostname string) (*core.Deployment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	deployment, exists := s.deployments[hostname]
	if !exists {
		return nil, fmt.Errorf("deployment not found for hostname: %s", hostname)
	}

	// Return a copy to avoid race conditions
	deploymentCopy := *deployment
	return &deploymentCopy, nil
}

// SaveDeployment saves a deployment
func (s *MemoryStore) SaveDeployment(deployment *core.Deployment) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Create a copy to store
	deploymentCopy := *deployment
	s.deployments[deployment.Hostname] = &deploymentCopy
	return nil
}

// ListDeployments returns all deployments
func (s *MemoryStore) ListDeployments() ([]*core.Deployment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	deployments := make([]*core.Deployment, 0, len(s.deployments))
	for _, deployment := range s.deployments {
		// Return copies
		deploymentCopy := *deployment
		deployments = append(deployments, &deploymentCopy)
	}

	return deployments, nil
}

// DeleteDeployment removes a deployment
func (s *MemoryStore) DeleteDeployment(hostname string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.deployments, hostname)
	return nil
}
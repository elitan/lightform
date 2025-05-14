package scaling

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/elitan/luma/src/pkg/container"
)

// ServiceConfig holds configuration for a service
type ServiceConfig struct {
	Name        string
	Image       string
	MinReplicas int
	MaxReplicas int
}

// Scaler handles scaling of services based on request load
type Scaler struct {
	containerManager *container.Manager
	services         map[string]*ServiceConfig
	mu               sync.RWMutex
}

// New creates a new scaler
func New(manager *container.Manager) *Scaler {
	return &Scaler{
		containerManager: manager,
		services:         make(map[string]*ServiceConfig),
	}
}

// RegisterService adds a new service to be managed by the scaler
func (s *Scaler) RegisterService(config ServiceConfig) {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	s.services[config.Name] = &config
	
	// Ensure minimum replicas are running
	if config.MinReplicas > 0 {
		go s.ensureMinReplicas(config.Name)
	}
}

// ScaleUp attempts to scale up a service by starting a new container
func (s *Scaler) ScaleUp(serviceName string) error {
	s.mu.RLock()
	config, exists := s.services[serviceName]
	s.mu.RUnlock()
	
	if !exists {
		return nil // Service not registered
	}
	
	// Count current instances
	instances := 0
	containers := s.containerManager.ListContainers()
	for _, c := range containers {
		if c.Name == serviceName || c.Name == config.Name {
			instances++
		}
	}
	
	// Check if we're at max replicas
	if instances >= config.MaxReplicas {
		log.Printf("Service %s already at max replicas (%d)", serviceName, config.MaxReplicas)
		return nil
	}
	
	// Start a new container
	instanceName := generateInstanceName(serviceName, instances+1)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	
	_, err := s.containerManager.StartContainer(ctx, instanceName, config.Image)
	if err != nil {
		return err
	}
	
	log.Printf("Scaled up service %s, instance %s", serviceName, instanceName)
	return nil
}

// ensureMinReplicas makes sure the minimum number of replicas are running
func (s *Scaler) ensureMinReplicas(serviceName string) {
	s.mu.RLock()
	config, exists := s.services[serviceName]
	s.mu.RUnlock()
	
	if !exists {
		return
	}
	
	// Count current instances
	instances := 0
	containers := s.containerManager.ListContainers()
	for _, c := range containers {
		if c.Name == serviceName || c.Name == config.Name {
			instances++
		}
	}
	
	// Start containers if needed
	for i := instances; i < config.MinReplicas; i++ {
		instanceName := generateInstanceName(serviceName, i+1)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		
		log.Printf("Starting instance %s to meet minimum replica count", instanceName)
		_, err := s.containerManager.StartContainer(ctx, instanceName, config.Image)
		if err != nil {
			log.Printf("Error starting instance %s: %v", instanceName, err)
		}
		
		cancel()
	}
}

// generateInstanceName creates a unique name for a service instance
func generateInstanceName(serviceName string, index int) string {
	return serviceName + "-" + time.Now().Format("20060102150405") + "-" + string('0'+rune(index%10))
}
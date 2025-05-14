package container

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
)

// Container represents a running container instance
type Container struct {
	ID          string
	Name        string
	Image       string
	TargetURL   string
	StartTime   time.Time
	LastActive  time.Time
	Status      string
	ExposedPort int
	mu          sync.RWMutex
}

// Manager handles container lifecycle operations
type Manager struct {
	client           *client.Client
	containers       map[string]*Container
	mu               sync.RWMutex
	basePort         int
	inactivityPeriod time.Duration
}

// NewManager creates a new container manager
func NewManager(inactivityPeriod time.Duration) (*Manager, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv)
	if err != nil {
		return nil, fmt.Errorf("failed to create Docker client: %w", err)
	}

	manager := &Manager{
		client:           cli,
		containers:       make(map[string]*Container),
		basePort:         8000,
		inactivityPeriod: inactivityPeriod,
	}

	// Start background goroutine for cleanup
	go manager.cleanupInactive()

	return manager, nil
}

// StartContainer starts a new container with the specified image
func (m *Manager) StartContainer(ctx context.Context, name, image string) (*Container, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Check if container already exists
	if container, exists := m.containers[name]; exists {
		container.mu.Lock()
		container.LastActive = time.Now()
		container.mu.Unlock()
		return container, nil
	}

	// Assign a port for the container
	port := m.nextAvailablePort()
	hostConfig := &container.HostConfig{
		PortBindings: nat.PortMap{
			nat.Port("3000/tcp"): []nat.PortBinding{
				{
					HostIP:   "0.0.0.0",
					HostPort: fmt.Sprintf("%d", port),
				},
			},
		},
		NetworkMode: "luma-net", // Join the same network as Caddy
	}

	// Container config
	config := &container.Config{
		Image: image,
		ExposedPorts: nat.PortSet{
			"3000/tcp": struct{}{},
		},
	}

	// Create and start the container
	resp, err := m.client.ContainerCreate(ctx, config, hostConfig, nil, nil, name)
	if err != nil {
		return nil, fmt.Errorf("failed to create container: %w", err)
	}

	if err := m.client.ContainerStart(ctx, resp.ID, types.ContainerStartOptions{}); err != nil {
		return nil, fmt.Errorf("failed to start container: %w", err)
	}

	// Create container object
	c := &Container{
		ID:          resp.ID,
		Name:        name,
		Image:       image,
		TargetURL:   fmt.Sprintf("http://localhost:%d", port),
		StartTime:   time.Now(),
		LastActive:  time.Now(),
		Status:      "starting",
		ExposedPort: port,
	}

	// Add to map
	m.containers[name] = c

	// Wait for container to be ready (in a real system, implement proper readiness check)
	go func() {
		// Simulate waiting for readiness
		time.Sleep(2 * time.Second)
		c.mu.Lock()
		c.Status = "running"
		c.mu.Unlock()
		log.Printf("Container %s is now ready at %s", name, c.TargetURL)
	}()

	return c, nil
}

// StopContainer stops a running container
func (m *Manager) StopContainer(ctx context.Context, name string) error {
	m.mu.Lock()
	container, exists := m.containers[name]
	if !exists {
		m.mu.Unlock()
		return fmt.Errorf("container %s not found", name)
	}
	m.mu.Unlock()

	timeout := 10 * time.Second
	if err := m.client.ContainerStop(ctx, container.ID, &timeout); err != nil {
		return fmt.Errorf("failed to stop container: %w", err)
	}

	if err := m.client.ContainerRemove(ctx, container.ID, types.ContainerRemoveOptions{}); err != nil {
		return fmt.Errorf("failed to remove container: %w", err)
	}

	m.mu.Lock()
	delete(m.containers, name)
	m.mu.Unlock()

	log.Printf("Container %s stopped and removed", name)
	return nil
}

// GetContainer returns a container by name
func (m *Manager) GetContainer(name string) (*Container, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	container, exists := m.containers[name]
	return container, exists
}

// UpdateLastActive updates the last active timestamp for a container
func (m *Manager) UpdateLastActive(name string) {
	m.mu.RLock()
	container, exists := m.containers[name]
	m.mu.RUnlock()

	if exists {
		container.mu.Lock()
		container.LastActive = time.Now()
		container.mu.Unlock()
	}
}

// ListContainers returns all managed containers
func (m *Manager) ListContainers() []*Container {
	m.mu.RLock()
	defer m.mu.RUnlock()

	containers := make([]*Container, 0, len(m.containers))
	for _, c := range m.containers {
		containers = append(containers, c)
	}
	return containers
}

// cleanupInactive periodically checks for and stops inactive containers
func (m *Manager) cleanupInactive() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		now := time.Now()
		var containersToStop []string

		m.mu.RLock()
		for name, container := range m.containers {
			container.mu.RLock()
			if now.Sub(container.LastActive) > m.inactivityPeriod {
				containersToStop = append(containersToStop, name)
			}
			container.mu.RUnlock()
		}
		m.mu.RUnlock()

		for _, name := range containersToStop {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			log.Printf("Stopping inactive container: %s", name)
			if err := m.StopContainer(ctx, name); err != nil {
				log.Printf("Error stopping container %s: %v", name, err)
			}
			cancel()
		}
	}
}

// nextAvailablePort finds the next available port to use
func (m *Manager) nextAvailablePort() int {
	// Simple port assignment - in a real system, check if port is actually available
	return m.basePort + len(m.containers)
}
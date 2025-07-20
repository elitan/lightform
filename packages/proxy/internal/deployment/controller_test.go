package deployment

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/elitan/iop/proxy/internal/core"
	"github.com/elitan/iop/proxy/internal/events"
	"github.com/elitan/iop/proxy/internal/storage"
)

// mockHealthChecker always returns success or failure based on configuration
type mockHealthChecker struct {
	shouldPass bool
}

func (m *mockHealthChecker) CheckHealth(ctx context.Context, target, healthPath string) error {
	if m.shouldPass {
		return nil
	}
	return fmt.Errorf("health check failed")
}

// mockProxyUpdater captures route updates
type mockProxyUpdater struct {
	mu     sync.Mutex
	routes map[string]mockRoute
}

type mockRoute struct {
	target  string
	healthy bool
}

func newMockProxyUpdater() *mockProxyUpdater {
	return &mockProxyUpdater{
		routes: make(map[string]mockRoute),
	}
}

func (m *mockProxyUpdater) UpdateRoute(hostname, target string, healthy bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.routes[hostname] = mockRoute{target: target, healthy: healthy}
}

func (m *mockProxyUpdater) GetRoute(hostname string) mockRoute {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.routes[hostname]
}

func TestController(t *testing.T) {
	// Setup
	store := storage.NewMemoryStore()
	eventBus := events.NewSimpleBus()
	healthService := &mockHealthChecker{shouldPass: true}
	proxyUpdater := newMockProxyUpdater()
	
	controller := NewController(store, proxyUpdater, healthService, eventBus)

	t.Run("successful deployment with immediate cleanup", func(t *testing.T) {
		ctx := context.Background()
		
		// Deploy first version (blue)
		err := controller.Deploy(ctx, "myapp.com", "myimage:v1", "myproject", "webapp")
		if err != nil {
			t.Fatalf("First deployment failed: %v", err)
		}
		
		// Wait for health check and traffic switch
		time.Sleep(100 * time.Millisecond)
		
		// Check deployment status
		deployment, err := controller.GetStatus("myapp.com")
		if err != nil {
			t.Fatalf("Failed to get deployment status: %v", err)
		}
		
		if deployment.Hostname != "myapp.com" {
			t.Errorf("Expected hostname myapp.com, got %s", deployment.Hostname)
		}
		
		// Check that traffic was routed correctly
		if proxyUpdater.GetRoute("myapp.com").target == "" {
			t.Error("Expected route to be set for myapp.com")
		}
		
		// Deploy second version (green) - should immediately clean up blue
		err = controller.Deploy(ctx, "myapp.com", "myimage:v2", "myproject", "webapp")
		if err != nil {
			t.Fatalf("Second deployment failed: %v", err)
		}
		
		// Wait for health check and traffic switch
		time.Sleep(100 * time.Millisecond)
		
		// Check final deployment status
		deployment, err = controller.GetStatus("myapp.com")
		if err != nil {
			t.Fatalf("Failed to get final deployment status: %v", err)
		}
		
		// Check that the active container is healthy
		var activeContainer core.Container
		if deployment.Active == core.Blue {
			activeContainer = deployment.Blue
		} else {
			activeContainer = deployment.Green
		}
		
		if activeContainer.HealthState != core.HealthHealthy {
			t.Errorf("Expected active container to be healthy, got %s", activeContainer.HealthState)
		}
		
		// Check that the inactive container was cleaned up (target should be empty)
		var inactiveContainer core.Container
		if deployment.Active == core.Blue {
			inactiveContainer = deployment.Green
		} else {
			inactiveContainer = deployment.Blue
		}
		
		if inactiveContainer.Target != "" && inactiveContainer.HealthState != core.HealthStopped {
			t.Errorf("Expected inactive container to be cleaned up, got target=%s, health=%s", 
				inactiveContainer.Target, inactiveContainer.HealthState)
		}
		
		t.Log("Deployment with immediate cleanup completed successfully!")
	})

	t.Run("container naming convention", func(t *testing.T) {
		controller := NewController(store, proxyUpdater, healthService, eventBus)
		
		// Test container name generation
		blueName := controller.generateContainerName("myapp.com", core.Blue)
		greenName := controller.generateContainerName("myapp.com", core.Green)
		
		expectedBlue := "myapp-com-blue"
		expectedGreen := "myapp-com-green"
		
		if blueName != expectedBlue {
			t.Errorf("Expected blue container name %s, got %s", expectedBlue, blueName)
		}
		
		if greenName != expectedGreen {
			t.Errorf("Expected green container name %s, got %s", expectedGreen, greenName)
		}
		
		// Test target extraction
		containerName := controller.extractContainerName("myapp-com-blue:3000")
		if containerName != "myapp-com-blue" {
			t.Errorf("Expected container name myapp-com-blue, got %s", containerName)
		}
	})
}
package test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/elitan/iop/proxy/internal/core"
	"github.com/elitan/iop/proxy/internal/deployment"
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
	m.routes[hostname] = mockRoute{target: target, healthy: healthy}
}

// TestControllerIntegration tests the Controller with proper event flow
func TestControllerIntegration(t *testing.T) {
	// Setup
	store := storage.NewMemoryStore()
	eventBus := events.NewSimpleBus()
	healthService := &mockHealthChecker{shouldPass: true}
	proxyUpdater := newMockProxyUpdater()
	
	controller := deployment.NewController(store, proxyUpdater, healthService, eventBus)

	// Subscribe to deployment events
	eventCh := eventBus.Subscribe()
	defer eventBus.Unsubscribe(eventCh)

	t.Run("complete deployment lifecycle with cleanup", func(t *testing.T) {
		ctx := context.Background()

		// Step 1: Deploy first version
		t.Log("Deploying first version...")
		err := controller.Deploy(ctx, "myapp.com", "myapp:v1", "myproject", "web")
		if err != nil {
			t.Fatalf("Failed to deploy first version: %v", err)
		}

		// Wait for health check and traffic switch
		time.Sleep(100 * time.Millisecond)

		// Verify first deployment
		deployment, err := controller.GetStatus("myapp.com")
		if err != nil {
			t.Fatalf("Failed to get deployment status: %v", err)
		}

		if deployment.Hostname != "myapp.com" {
			t.Errorf("Expected hostname myapp.com, got %s", deployment.Hostname)
		}

		// Check that proxy was updated
		if proxyUpdater.routes["myapp.com"].target == "" {
			t.Error("Expected route to be set for myapp.com")
		}

		// Step 2: Deploy second version (should cleanup first)
		t.Log("Deploying second version...")
		err = controller.Deploy(ctx, "myapp.com", "myapp:v2", "myproject", "web")
		if err != nil {
			t.Fatalf("Failed to deploy second version: %v", err)
		}

		// Wait for health check and traffic switch
		time.Sleep(100 * time.Millisecond)

		// Verify second deployment
		deployment, err = controller.GetStatus("myapp.com")
		if err != nil {
			t.Fatalf("Failed to get final deployment status: %v", err)
		}

		// Check that the active container is healthy
		var activeContainer, inactiveContainer core.Container
		if deployment.Active == core.Blue {
			activeContainer = deployment.Blue
			inactiveContainer = deployment.Green
		} else {
			activeContainer = deployment.Green
			inactiveContainer = deployment.Blue
		}

		if activeContainer.HealthState != core.HealthHealthy {
			t.Errorf("Expected active container to be healthy, got %s", activeContainer.HealthState)
		}

		// Check immediate cleanup behavior
		if inactiveContainer.Target != "" && inactiveContainer.HealthState != core.HealthStopped {
			t.Errorf("Expected inactive container to be cleaned up, got target=%s, health=%s", 
				inactiveContainer.Target, inactiveContainer.HealthState)
		}

		t.Log("Complete deployment lifecycle with cleanup completed successfully!")
	})

	t.Run("event flow verification", func(t *testing.T) {
		// Collect events from the previous test
		events := make([]string, 0)
		timeout := time.After(500 * time.Millisecond)

		for {
			select {
			case event := <-eventCh:
				switch event.(type) {
				case *core.DeploymentStarted:
					events = append(events, "DeploymentStarted")
				case *core.TrafficSwitched:
					events = append(events, "TrafficSwitched")
				case *core.DeploymentCompleted:
					events = append(events, "DeploymentCompleted")
				}
			case <-timeout:
				goto checkEvents
			}
		}

	checkEvents:
		// We should have seen both deployments
		expectedEvents := []string{
			"DeploymentStarted", "TrafficSwitched", "DeploymentCompleted", // First deployment
			"DeploymentStarted", "TrafficSwitched", "DeploymentCompleted", // Second deployment
		}

		if len(events) < len(expectedEvents) {
			t.Errorf("Expected at least %d events, got %d: %v", len(expectedEvents), len(events), events)
		}

		t.Logf("Events received: %v", events)
	})

	t.Run("container naming validation", func(t *testing.T) {
		// Test the container naming conventions
		deployment, err := controller.GetStatus("myapp.com")
		if err != nil {
			t.Fatalf("Failed to get deployment status: %v", err)
		}

		// Check that container targets follow proper naming
		var activeContainer core.Container
		if deployment.Active == core.Blue {
			activeContainer = deployment.Blue
		} else {
			activeContainer = deployment.Green
		}

		expectedTarget := "myapp-com-" + string(deployment.Active) + ":3000"
		if activeContainer.Target != expectedTarget {
			t.Errorf("Expected container target %s, got %s", expectedTarget, activeContainer.Target)
		}

		t.Log("Container naming validation completed!")
	})
}
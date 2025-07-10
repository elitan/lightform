package deployment

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/elitan/lightform/proxy/internal/core"
	"github.com/elitan/lightform/proxy/internal/events"
	"github.com/elitan/lightform/proxy/internal/storage"
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

func TestDeploymentController(t *testing.T) {
	t.Run("successful deployment", func(t *testing.T) {
		// Setup
		store := storage.NewMemoryStore()
		proxy := newMockProxyUpdater()
		health := &mockHealthChecker{shouldPass: true}
		bus := events.NewSimpleBus()
		
		controller := NewController(store, proxy, health, bus)

		// Subscribe to events
		events := bus.Subscribe()
		defer bus.Unsubscribe(events)

		// Deploy
		ctx := context.Background()
		err := controller.Deploy(ctx, "test.com", "localhost:3001", "test-project", "web")
		if err != nil {
			t.Fatalf("Deploy failed: %v", err)
		}

		// Wait for health check and traffic switch
		time.Sleep(100 * time.Millisecond)

		// Verify deployment state
		deployment, err := controller.GetStatus("test.com")
		if err != nil {
			t.Fatalf("GetStatus failed: %v", err)
		}

		if deployment.Hostname != "test.com" {
			t.Errorf("Expected hostname test.com, got %s", deployment.Hostname)
		}

		// Verify proxy was updated
		route, exists := proxy.routes["test.com"]
		if !exists {
			t.Fatal("Proxy route not updated")
		}

		if route.target != "localhost:3001" {
			t.Errorf("Expected target localhost:3001, got %s", route.target)
		}

		if !route.healthy {
			t.Error("Expected route to be healthy")
		}

		// Check events
		eventCount := 0
		timeout := time.After(1 * time.Second)
		
		for eventCount < 2 { // Expecting DeploymentStarted and HealthCheckPassed
			select {
			case event := <-events:
				switch e := event.(type) {
				case *core.DeploymentStarted:
					if e.Hostname != "test.com" {
						t.Errorf("Expected deployment started for test.com, got %s", e.Hostname)
					}
				case *core.HealthCheckPassed:
					if e.Hostname != "test.com" {
						t.Errorf("Expected health check passed for test.com, got %s", e.Hostname)
					}
				case *core.TrafficSwitched:
					if e.Hostname != "test.com" {
						t.Errorf("Expected traffic switched for test.com, got %s", e.Hostname)
					}
				}
				eventCount++
			case <-timeout:
				t.Fatalf("Timeout waiting for events, got %d events", eventCount)
			}
		}
	})

	t.Run("failed health check", func(t *testing.T) {
		// Setup
		store := storage.NewMemoryStore()
		proxy := newMockProxyUpdater()
		health := &mockHealthChecker{shouldPass: false}
		bus := events.NewSimpleBus()
		
		controller := NewController(store, proxy, health, bus)

		// Subscribe to events
		events := bus.Subscribe()
		defer bus.Unsubscribe(events)

		// Deploy
		ctx := context.Background()
		err := controller.Deploy(ctx, "test.com", "localhost:3001", "test-project", "web")
		if err != nil {
			t.Fatalf("Deploy failed: %v", err)
		}

		// Wait for health check to fail
		time.Sleep(100 * time.Millisecond)

		// Verify deployment state
		deployment, err := controller.GetStatus("test.com")
		if err != nil {
			t.Fatalf("GetStatus failed: %v", err)
		}

		// Check that the inactive container is unhealthy
		inactiveColor := core.Green
		if deployment.Active == core.Green {
			inactiveColor = core.Blue
		}

		var container core.Container
		if inactiveColor == core.Blue {
			container = deployment.Blue
		} else {
			container = deployment.Green
		}

		if container.HealthState != core.HealthChecking {
			t.Errorf("Expected container to be health checking, got %s", container.HealthState)
		}

		// Verify proxy was NOT updated (no traffic switch)
		_, exists := proxy.routes["test.com"]
		if exists {
			t.Error("Proxy should not have been updated for failed deployment")
		}
	})
}
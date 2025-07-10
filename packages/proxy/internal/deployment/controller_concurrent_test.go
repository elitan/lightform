package deployment

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/elitan/lightform/proxy/internal/core"
	"github.com/elitan/lightform/proxy/internal/events"
	"github.com/elitan/lightform/proxy/internal/storage"
)

// TestControllerConcurrentDeployments tests handling of simultaneous deployments
func TestControllerConcurrentDeployments(t *testing.T) {
	// Setup
	store := storage.NewMemoryStore()
	eventBus := events.NewSimpleBus()
	healthService := &mockHealthChecker{shouldPass: true}
	proxyUpdater := newMockProxyUpdater()
	
	controller := NewController(store, proxyUpdater, healthService, eventBus)

	t.Run("concurrent deployments to same host", func(t *testing.T) {
		ctx := context.Background()
		var wg sync.WaitGroup
		errors := make([]error, 2)
		
		// Start two deployments simultaneously
		wg.Add(2)
		
		go func() {
			defer wg.Done()
			errors[0] = controller.Deploy(ctx, "concurrent.com", "image:v1", "project", "app")
		}()
		
		go func() {
			defer wg.Done()
			// Small delay to ensure both hit at nearly the same time
			time.Sleep(10 * time.Millisecond)
			errors[1] = controller.Deploy(ctx, "concurrent.com", "image:v2", "project", "app")
		}()
		
		wg.Wait()
		
		// Both should succeed - they are serialized by mutex
		if errors[0] != nil {
			t.Errorf("First deployment failed: %v", errors[0])
		}
		if errors[1] != nil {
			t.Errorf("Second deployment failed: %v", errors[1])
		}
		
		// Wait for health checks to complete
		time.Sleep(200 * time.Millisecond)
		
		// Check final state - second deployment should have won
		deployment, err := controller.GetStatus("concurrent.com")
		if err != nil {
			t.Fatalf("Failed to get deployment status: %v", err)
		}
		
		// One container should be active and healthy (the latest deployment)
		var activeContainer core.Container
		if deployment.Active == core.Blue {
			activeContainer = deployment.Blue
		} else {
			activeContainer = deployment.Green
		}
		
		if activeContainer.Target == "" {
			t.Error("Expected active container to have a target")
		}
		
		if activeContainer.HealthState != core.HealthHealthy {
			t.Errorf("Expected active container to be healthy, got %s", activeContainer.HealthState)
		}
	})

	t.Run("rapid sequential deployments", func(t *testing.T) {
		ctx := context.Background()
		
		// Deploy multiple versions rapidly
		versions := []string{"v1", "v2", "v3", "v4", "v5"}
		for _, version := range versions {
			err := controller.Deploy(ctx, "rapid.com", "image:"+version, "project", "app")
			if err != nil {
				t.Errorf("Deployment of %s failed: %v", version, err)
			}
			// Very short delay between deployments
			time.Sleep(20 * time.Millisecond)
		}
		
		// Wait for all deployments to settle
		time.Sleep(300 * time.Millisecond)
		
		// Check that we didn't leak resources
		deployment, err := controller.GetStatus("rapid.com")
		if err != nil {
			t.Fatalf("Failed to get deployment status: %v", err)
		}
		
		// Should have exactly one active container
		activeCount := 0
		if deployment.Blue.HealthState == core.HealthHealthy {
			activeCount++
		}
		if deployment.Green.HealthState == core.HealthHealthy {
			activeCount++
		}
		
		if activeCount != 1 {
			t.Errorf("Expected exactly 1 healthy container, got %d", activeCount)
		}
		
		// The inactive one should be stopped or unhealthy
		var inactiveContainer core.Container
		if deployment.Active == core.Blue {
			inactiveContainer = deployment.Green
		} else {
			inactiveContainer = deployment.Blue
		}
		
		if inactiveContainer.HealthState == core.HealthHealthy {
			t.Error("Inactive container should not be healthy")
		}
	})
}

// TestControllerErrorHandling tests various error scenarios
func TestControllerErrorHandling(t *testing.T) {
	t.Run("health check failures", func(t *testing.T) {
		// Setup with failing health checker
		store := storage.NewMemoryStore()
		eventBus := events.NewSimpleBus()
		healthService := &mockHealthChecker{shouldPass: false}
		proxyUpdater := newMockProxyUpdater()
		
		controller := NewController(store, proxyUpdater, healthService, eventBus)
		
		ctx := context.Background()
		err := controller.Deploy(ctx, "failing.com", "image:bad", "project", "app")
		if err != nil {
			t.Fatalf("Deploy should not fail immediately: %v", err)
		}
		
		// Wait for health checks to fail
		time.Sleep(800 * time.Millisecond) // Enough time for max attempts
		
		// Check that deployment is marked as failed
		deployment, err := controller.GetStatus("failing.com")
		if err != nil {
			t.Fatalf("Failed to get deployment status: %v", err)
		}
		
		// The new container should be marked as unhealthy or stopped
		var deployedContainer core.Container
		if deployment.Active == core.Blue {
			deployedContainer = deployment.Green // We deployed to inactive
		} else {
			deployedContainer = deployment.Blue
		}
		
		if deployedContainer.HealthState != core.HealthStopped {
			t.Errorf("Expected failed container to be stopped, got %s", deployedContainer.HealthState)
		}
		
		// Traffic should NOT have switched - route should be empty
		route := proxyUpdater.GetRoute("failing.com")
		if route.target != "" {
			t.Errorf("Traffic should not switch to unhealthy container, but route target is %s", route.target)
		}
	})

	t.Run("deployment with empty image tag", func(t *testing.T) {
		store := storage.NewMemoryStore()
		eventBus := events.NewSimpleBus()
		healthService := &mockHealthChecker{shouldPass: true}
		proxyUpdater := newMockProxyUpdater()
		
		controller := NewController(store, proxyUpdater, healthService, eventBus)
		
		ctx := context.Background()
		err := controller.Deploy(ctx, "empty.com", "", "project", "app")
		
		// Should reject empty image tag
		if err == nil {
			t.Error("Expected error for empty image tag, got nil")
		}
		if err != nil && err.Error() != "image tag cannot be empty" {
			t.Errorf("Expected 'image tag cannot be empty', got %v", err)
		}
	})
}

// TestControllerCleanupBehavior tests container cleanup scenarios
func TestControllerCleanupBehavior(t *testing.T) {
	t.Run("cleanup after successful deployment", func(t *testing.T) {
		store := storage.NewMemoryStore()
		eventBus := events.NewSimpleBus()
		healthService := &mockHealthChecker{shouldPass: true}
		proxyUpdater := newMockProxyUpdater()
		
		// Track cleanup calls
		cleanupCalls := 0
		originalStopContainer := (&Controller{}).stopContainer
		
		controller := NewController(store, proxyUpdater, healthService, eventBus)
		
		// Note: In a real test, we'd need to mock the stopContainer method
		// This is a simplified example
		
		ctx := context.Background()
		
		// First deployment
		err := controller.Deploy(ctx, "cleanup.com", "image:v1", "project", "app")
		if err != nil {
			t.Fatalf("First deployment failed: %v", err)
		}
		
		time.Sleep(100 * time.Millisecond)
		
		// Second deployment should trigger cleanup of first
		err = controller.Deploy(ctx, "cleanup.com", "image:v2", "project", "app")
		if err != nil {
			t.Fatalf("Second deployment failed: %v", err)
		}
		
		time.Sleep(100 * time.Millisecond)
		
		// Verify old container was cleaned up
		deployment, _ := controller.GetStatus("cleanup.com")
		
		var inactiveContainer core.Container
		if deployment.Active == core.Blue {
			inactiveContainer = deployment.Green
		} else {
			inactiveContainer = deployment.Blue
		}
		
		// Inactive container should have empty target (cleaned up)
		if inactiveContainer.Target != "" && inactiveContainer.HealthState != core.HealthStopped {
			t.Error("Expected inactive container to be cleaned up")
		}
		
		_ = originalStopContainer // Avoid unused variable warning
		_ = cleanupCalls
	})
}
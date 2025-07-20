package deployment

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/elitan/iop/proxy/internal/core"
	"github.com/elitan/iop/proxy/internal/events"
	"github.com/elitan/iop/proxy/internal/storage"
)

// TestControllerUnderLoad tests deployment behavior when proxy is handling traffic
func TestControllerUnderLoad(t *testing.T) {
	t.Run("deployment during active traffic", func(t *testing.T) {
		// Setup
		store := storage.NewMemoryStore()
		eventBus := events.NewSimpleBus()
		healthService := &mockHealthChecker{shouldPass: true}
		proxyUpdater := &loadTestProxyUpdater{
			mockProxyUpdater: newMockProxyUpdater(),
			requestCount:     &atomic.Int32{},
		}
		
		controller := NewController(store, proxyUpdater, healthService, eventBus)
		ctx := context.Background()
		
		// Initial deployment
		err := controller.Deploy(ctx, "loaded.com", "image:v1", "project", "app")
		if err != nil {
			t.Fatalf("Initial deployment failed: %v", err)
		}
		
		// Wait for it to become active
		time.Sleep(100 * time.Millisecond)
		
		// Start simulating traffic
		stopTraffic := make(chan struct{})
		var trafficWg sync.WaitGroup
		trafficWg.Add(1)
		
		go func() {
			defer trafficWg.Done()
			ticker := time.NewTicker(5 * time.Millisecond)
			defer ticker.Stop()
			
			for {
				select {
				case <-stopTraffic:
					return
				case <-ticker.C:
					// Simulate a request
					proxyUpdater.requestCount.Add(1)
				}
			}
		}()
		
		// Let traffic run for a bit
		time.Sleep(50 * time.Millisecond)
		beforeCount := proxyUpdater.requestCount.Load()
		
		// Deploy new version while traffic is running
		err = controller.Deploy(ctx, "loaded.com", "image:v2", "project", "app")
		if err != nil {
			t.Fatalf("Second deployment failed: %v", err)
		}
		
		// Wait for deployment to complete
		time.Sleep(150 * time.Millisecond)
		
		// Stop traffic
		close(stopTraffic)
		trafficWg.Wait()
		
		afterCount := proxyUpdater.requestCount.Load()
		
		// Verify traffic continued during deployment
		if afterCount <= beforeCount {
			t.Error("Expected traffic to continue during deployment")
		}
		
		// Verify deployment succeeded
		deployment, err := controller.GetStatus("loaded.com")
		if err != nil {
			t.Fatalf("Failed to get deployment status: %v", err)
		}
		
		// Active container should be healthy
		var activeContainer core.Container
		if deployment.Active == core.Blue {
			activeContainer = deployment.Blue
		} else {
			activeContainer = deployment.Green
		}
		
		if activeContainer.HealthState != core.HealthHealthy {
			t.Errorf("Expected active container to be healthy after deployment under load, got %s", 
				activeContainer.HealthState)
		}
		
		t.Logf("Handled %d requests during deployment", afterCount-beforeCount)
	})
	
	t.Run("multiple hosts under load", func(t *testing.T) {
		// Setup
		store := storage.NewMemoryStore()
		eventBus := events.NewSimpleBus()
		healthService := &mockHealthChecker{shouldPass: true}
		proxyUpdater := newMockProxyUpdater()
		
		controller := NewController(store, proxyUpdater, healthService, eventBus)
		ctx := context.Background()
		
		// Deploy to multiple hosts
		hosts := []string{"app1.com", "app2.com", "app3.com", "app4.com", "app5.com"}
		
		var wg sync.WaitGroup
		for i, host := range hosts {
			wg.Add(1)
			go func(h string, version int) {
				defer wg.Done()
				
				// Deploy initial version
				err := controller.Deploy(ctx, h, fmt.Sprintf("image:v%d", version), "project", "app")
				if err != nil {
					t.Errorf("Failed to deploy to %s: %v", h, err)
				}
				
				// Wait a bit then deploy update
				time.Sleep(100 * time.Millisecond)
				
				err = controller.Deploy(ctx, h, fmt.Sprintf("image:v%d-updated", version), "project", "app")
				if err != nil {
					t.Errorf("Failed to update %s: %v", h, err)
				}
			}(host, i+1)
		}
		
		wg.Wait()
		
		// Wait for all deployments to complete
		time.Sleep(200 * time.Millisecond)
		
		// Verify all hosts are properly deployed
		for _, host := range hosts {
			deployment, err := controller.GetStatus(host)
			if err != nil {
				t.Errorf("Failed to get status for %s: %v", host, err)
				continue
			}
			
			// Should have one healthy container
			var activeContainer core.Container
			if deployment.Active == core.Blue {
				activeContainer = deployment.Blue
			} else {
				activeContainer = deployment.Green
			}
			
			if activeContainer.HealthState != core.HealthHealthy {
				t.Errorf("Host %s: expected healthy container, got %s", 
					host, activeContainer.HealthState)
			}
		}
	})
}

// loadTestProxyUpdater tracks request counts during updates
type loadTestProxyUpdater struct {
	*mockProxyUpdater
	requestCount *atomic.Int32
}

// TestDeploymentIdempotency tests that deployments are idempotent
func TestDeploymentIdempotency(t *testing.T) {
	// Setup
	store := storage.NewMemoryStore()
	eventBus := events.NewSimpleBus()
	healthService := &mockHealthChecker{shouldPass: true}
	proxyUpdater := newMockProxyUpdater()
	
	controller := NewController(store, proxyUpdater, healthService, eventBus)
	ctx := context.Background()
	
	// Deploy same version multiple times
	for i := 0; i < 3; i++ {
		err := controller.Deploy(ctx, "idempotent.com", "image:v1", "project", "app")
		if err != nil {
			t.Fatalf("Deployment %d failed: %v", i+1, err)
		}
		time.Sleep(150 * time.Millisecond)
	}
	
	// Should still have a working deployment
	deployment, err := controller.GetStatus("idempotent.com")
	if err != nil {
		t.Fatalf("Failed to get deployment status: %v", err)
	}
	
	// Should have exactly one healthy container
	healthyCount := 0
	if deployment.Blue.HealthState == core.HealthHealthy {
		healthyCount++
	}
	if deployment.Green.HealthState == core.HealthHealthy {
		healthyCount++
	}
	
	if healthyCount != 1 {
		t.Errorf("Expected exactly 1 healthy container after idempotent deployments, got %d", healthyCount)
	}
}
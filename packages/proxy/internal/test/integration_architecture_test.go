package test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/elitan/lightform/proxy/internal/core"
	"github.com/elitan/lightform/proxy/internal/deployment"
	"github.com/elitan/lightform/proxy/internal/events"
	"github.com/elitan/lightform/proxy/internal/proxy"
	"github.com/elitan/lightform/proxy/internal/services"
	"github.com/elitan/lightform/proxy/internal/storage"
)

// TestNewArchitectureIntegration tests the complete new architecture working together
func TestNewArchitectureIntegration(t *testing.T) {
	// Create backends
	blueBackend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
		}
		w.Write([]byte("blue-v1"))
	}))
	defer blueBackend.Close()

	greenBackend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
		}
		w.Write([]byte("green-v2"))
	}))
	defer greenBackend.Close()

	// Setup new architecture components
	store := storage.NewMemoryStore()
	eventBus := events.NewSimpleBus()
	healthService := services.NewHealthService()
	proxyService := proxy.NewProxy(nil) // No cert manager for this test

	// Create deployment controller
	controller := deployment.NewController(store, proxyService, healthService, eventBus)

	// Subscribe to deployment events
	eventCh := eventBus.Subscribe()
	defer eventBus.Unsubscribe(eventCh)

	t.Run("full deployment lifecycle", func(t *testing.T) {
		ctx := context.Background()

		// Step 1: Deploy blue version
		t.Log("Deploying blue version...")
		err := controller.Deploy(ctx, "myapp.com", blueBackend.Listener.Addr().String(), "myproject", "web")
		if err != nil {
			t.Fatalf("Failed to deploy blue: %v", err)
		}

		// Wait for health check and traffic switch
		time.Sleep(200 * time.Millisecond)

		// Test blue is serving traffic
		req := httptest.NewRequest("GET", "/", nil)
		req.Host = "myapp.com"
		w := httptest.NewRecorder()
		proxyService.ServeHTTP(w, req)

		if w.Body.String() != "blue-v1" {
			t.Errorf("Expected blue-v1, got %s", w.Body.String())
		}

		// Step 2: Deploy green version (blue-green deployment)
		t.Log("Deploying green version...")
		err = controller.Deploy(ctx, "myapp.com", greenBackend.Listener.Addr().String(), "myproject", "web")
		if err != nil {
			t.Fatalf("Failed to deploy green: %v", err)
		}

		// Wait for health check and traffic switch
		time.Sleep(200 * time.Millisecond)

		// Test green is now serving traffic
		w2 := httptest.NewRecorder()
		proxyService.ServeHTTP(w2, req)

		if w2.Body.String() != "green-v2" {
			t.Errorf("Expected green-v2 after deployment, got %s", w2.Body.String())
		}

		// Step 3: Verify deployment status
		status, err := controller.GetStatus("myapp.com")
		if err != nil {
			t.Fatalf("Failed to get status: %v", err)
		}

		if status.Hostname != "myapp.com" {
			t.Errorf("Expected hostname myapp.com, got %s", status.Hostname)
		}

		// The active container should be healthy
		activeContainer := status.Blue
		if status.Active == "green" {
			activeContainer = status.Green
		}

		if activeContainer.HealthState != "healthy" {
			t.Errorf("Expected active container to be healthy, got %s", activeContainer.HealthState)
		}

		t.Log("Full deployment lifecycle completed successfully!")
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
				case *core.HealthCheckPassed:
					events = append(events, "HealthCheckPassed")
				case *core.TrafficSwitched:
					events = append(events, "TrafficSwitched")
				}
			case <-timeout:
				goto checkEvents
			}
		}

	checkEvents:
		// We should have seen both deployments
		expectedEvents := []string{
			"DeploymentStarted", "HealthCheckPassed", "TrafficSwitched", // Blue deployment
			"DeploymentStarted", "HealthCheckPassed", "TrafficSwitched", // Green deployment
		}

		if len(events) < len(expectedEvents) {
			t.Errorf("Expected at least %d events, got %d: %v", len(expectedEvents), len(events), events)
		}

		t.Logf("Events received: %v", events)
	})

	t.Run("rollback functionality", func(t *testing.T) {
		ctx := context.Background()

		// Rollback to previous version
		t.Log("Rolling back...")
		err := controller.Rollback(ctx, "myapp.com")
		if err != nil {
			t.Fatalf("Rollback failed: %v", err)
		}

		// Wait for rollback to complete
		time.Sleep(100 * time.Millisecond)

		// Test blue is serving traffic again
		req := httptest.NewRequest("GET", "/", nil)
		req.Host = "myapp.com"
		w := httptest.NewRecorder()
		proxyService.ServeHTTP(w, req)

		if w.Body.String() != "blue-v1" {
			t.Errorf("Expected blue-v1 after rollback, got %s", w.Body.String())
		}

		t.Log("Rollback completed successfully!")
	})
}
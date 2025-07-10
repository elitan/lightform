package test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/elitan/lightform/proxy/internal/router"
	"github.com/elitan/lightform/proxy/internal/state"
)

// TestCurrentProxyBehavior documents the behavior we need to preserve
func TestCurrentProxyBehavior(t *testing.T) {
	// Create a temporary state file
	stateFile := "test-state.json"
	defer func() {
		// Cleanup
		_ = os.Remove(stateFile)
	}()

	t.Run("basic routing", func(t *testing.T) {
		// Setup
		st := state.NewState(stateFile)
		
		// Create a test backend
		backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("hello from backend"))
		}))
		defer backend.Close()
		
		// Deploy a host
		err := st.DeployHost("test.example.com", backend.Listener.Addr().String(), "test-project", "web", "/health", false)
		if err != nil {
			t.Fatalf("Failed to deploy host: %v", err)
		}
		
		// Mark as healthy
		err = st.UpdateHealthStatus("test.example.com", true)
		if err != nil {
			t.Fatalf("Failed to update health status: %v", err)
		}
		
		// Create router with mock cert manager
		rt := router.NewRouter(st, nil) // We'll need to handle nil cert manager
		
		// Test routing
		req := httptest.NewRequest("GET", "/", nil)
		req.Host = "test.example.com"
		w := httptest.NewRecorder()
		
		rt.ServeHTTP(w, req)
		
		if w.Code != http.StatusOK {
			t.Errorf("Expected 200, got %d", w.Code)
		}
		
		if w.Body.String() != "hello from backend" {
			t.Errorf("Expected 'hello from backend', got %s", w.Body.String())
		}
	})
	
	t.Run("unhealthy backend returns 503", func(t *testing.T) {
		st := state.NewState(stateFile)
		
		backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("should not see this"))
		}))
		defer backend.Close()
		
		// Deploy and mark as unhealthy
		st.DeployHost("unhealthy.example.com", backend.Listener.Addr().String(), "test-project", "web", "/health", false)
		st.UpdateHealthStatus("unhealthy.example.com", false)
		
		rt := router.NewRouter(st, nil)
		
		req := httptest.NewRequest("GET", "/", nil)
		req.Host = "unhealthy.example.com"
		w := httptest.NewRecorder()
		
		rt.ServeHTTP(w, req)
		
		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("Expected 503, got %d", w.Code)
		}
	})
	
	t.Run("switch target changes routing", func(t *testing.T) {
		st := state.NewState(stateFile)
		
		// Two backends
		blue := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("blue"))
		}))
		defer blue.Close()
		
		green := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("green"))
		}))
		defer green.Close()
		
		// Start with blue
		st.DeployHost("switch.example.com", blue.Listener.Addr().String(), "test-project", "web", "/health", false)
		st.UpdateHealthStatus("switch.example.com", true)
		
		rt := router.NewRouter(st, nil)
		
		// Test blue
		req := httptest.NewRequest("GET", "/", nil)
		req.Host = "switch.example.com"
		w := httptest.NewRecorder()
		rt.ServeHTTP(w, req)
		
		if w.Body.String() != "blue" {
			t.Errorf("Expected 'blue', got %s", w.Body.String())
		}
		
		// Switch to green
		err := st.SwitchTarget("switch.example.com", green.Listener.Addr().String())
		if err != nil {
			t.Fatalf("Failed to switch target: %v", err)
		}
		
		// Test green
		w = httptest.NewRecorder()
		rt.ServeHTTP(w, req)
		
		if w.Body.String() != "green" {
			t.Errorf("Expected 'green' after switch, got %s", w.Body.String())
		}
	})
}
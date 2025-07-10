package test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/elitan/lightform/proxy/internal/router"
	"github.com/elitan/lightform/proxy/internal/state"
)

// TestBlueGreenBehavior tests the specific behavior we need for zero-downtime deployments
func TestBlueGreenBehavior(t *testing.T) {
	stateFile := "test-blue-green.json"
	defer os.Remove(stateFile)

	t.Run("sequential traffic switching", func(t *testing.T) {
		st := state.NewState(stateFile)
		rt := router.NewRouter(st, nil)

		// Blue backend
		blue := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("blue"))
		}))
		defer blue.Close()

		// Green backend
		green := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("green"))
		}))
		defer green.Close()

		// Deploy blue
		st.DeployHost("app.example.com", blue.Listener.Addr().String(), "test", "web", "/health", false)
		st.UpdateHealthStatus("app.example.com", true)

		// Make some requests to blue
		for i := 0; i < 3; i++ {
			req := httptest.NewRequest("GET", "/", nil)
			req.Host = "app.example.com"
			w := httptest.NewRecorder()
			rt.ServeHTTP(w, req)
			
			if w.Body.String() != "blue" {
				t.Errorf("Expected 'blue' before switch, got %s", w.Body.String())
			}
		}

		// Switch to green
		st.SwitchTarget("app.example.com", green.Listener.Addr().String())

		// Make requests to green
		for i := 0; i < 3; i++ {
			req := httptest.NewRequest("GET", "/", nil)
			req.Host = "app.example.com"
			w := httptest.NewRecorder()
			rt.ServeHTTP(w, req)
			
			if w.Body.String() != "green" {
				t.Errorf("Expected 'green' after switch, got %s", w.Body.String())
			}
		}

		t.Log("Sequential traffic switching works correctly")
	})

	t.Run("connection draining", func(t *testing.T) {
		st := state.NewState(stateFile)
		rt := router.NewRouter(st, nil)

		// Slow backend that takes 100ms to respond
		slowRequests := int32(0)
		slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&slowRequests, 1)
			time.Sleep(100 * time.Millisecond)
			w.Write([]byte("slow-response"))
		}))
		defer slow.Close()

		// Fast backend
		fast := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("fast-response"))
		}))
		defer fast.Close()

		// Deploy slow backend
		st.DeployHost("drain.example.com", slow.Listener.Addr().String(), "test", "web", "/health", false)
		st.UpdateHealthStatus("drain.example.com", true)

		// Start a slow request
		done := make(chan string)
		go func() {
			req := httptest.NewRequest("GET", "/", nil)
			req.Host = "drain.example.com"
			w := httptest.NewRecorder()
			rt.ServeHTTP(w, req)
			done <- w.Body.String()
		}()

		// Switch to fast backend after 20ms (while slow request is in flight)
		time.Sleep(20 * time.Millisecond)
		st.SwitchTarget("drain.example.com", fast.Listener.Addr().String())

		// The in-flight request should complete with the slow backend response
		result := <-done
		if result != "slow-response" {
			t.Errorf("Expected 'slow-response' for in-flight request, got %s", result)
		}

		// New requests should go to fast backend
		req := httptest.NewRequest("GET", "/", nil)
		req.Host = "drain.example.com"
		w := httptest.NewRecorder()
		rt.ServeHTTP(w, req)
		
		if w.Body.String() != "fast-response" {
			t.Errorf("Expected 'fast-response' for new request, got %s", w.Body.String())
		}
	})

	t.Run("health check prevents unhealthy switch", func(t *testing.T) {
		st := state.NewState(stateFile)
		rt := router.NewRouter(st, nil)

		// Healthy backend
		healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("healthy"))
		}))
		defer healthy.Close()

		// Deploy and mark as healthy
		st.DeployHost("health.example.com", healthy.Listener.Addr().String(), "test", "web", "/health", false)
		st.UpdateHealthStatus("health.example.com", true)

		// Verify it works
		req := httptest.NewRequest("GET", "/", nil)
		req.Host = "health.example.com"
		w := httptest.NewRecorder()
		rt.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("Expected 200, got %d", w.Code)
		}

		// Create unhealthy backend
		unhealthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("unhealthy"))
		}))
		defer unhealthy.Close()

		// Switch target but mark as unhealthy
		st.SwitchTarget("health.example.com", unhealthy.Listener.Addr().String())
		st.UpdateHealthStatus("health.example.com", false)

		// Should get 503 now
		w = httptest.NewRecorder()
		rt.ServeHTTP(w, req)

		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("Expected 503 for unhealthy service, got %d", w.Code)
		}
	})
}
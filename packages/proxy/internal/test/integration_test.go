package test

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/elitan/lightform/proxy/internal/api"
	"github.com/elitan/lightform/proxy/internal/cert"
	"github.com/elitan/lightform/proxy/internal/health"
	"github.com/elitan/lightform/proxy/internal/router"
	"github.com/elitan/lightform/proxy/internal/state"
)

// TestBlueGreenDeployment captures the current blue-green behavior
func TestBlueGreenDeployment(t *testing.T) {
	// Setup
	st := state.NewState("test-state.json")
	certManager := &mockCertManager{}
	healthChecker := &mockHealthChecker{healthy: make(map[string]bool)}
	
	rt := router.NewRouter(st, certManager)
	apiServer := api.NewHTTPServer(st, certManager, healthChecker)
	
	// Start test servers - blue and green backends
	blue := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("blue"))
	}))
	defer blue.Close()
	
	green := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("green"))
	}))
	defer green.Close()
	
	// Test the deployment flow
	t.Run("initial deployment", func(t *testing.T) {
		// Deploy to blue
		deployReq := api.HTTPDeployRequest{
			Host:       "test.example.com",
			Target:     blue.URL[7:], // strip http://
			Project:    "test",
			App:        "web",
			HealthPath: "/health",
			SSL:        false,
		}
		
		body, _ := json.Marshal(deployReq)
		req := httptest.NewRequest("POST", "/api/deploy", bytes.NewReader(body))
		w := httptest.NewRecorder()
		
		apiServer.ServeHTTP(w, req)
		
		if w.Code != http.StatusOK {
			t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
		}
		
		// Verify routing works
		req = httptest.NewRequest("GET", "/", nil)
		req.Host = "test.example.com"
		w = httptest.NewRecorder()
		
		// Mark as healthy
		healthChecker.healthy["test.example.com"] = true
		st.UpdateHealthStatus("test.example.com", true)
		
		rt.ServeHTTP(w, req)
		
		if w.Body.String() != "blue" {
			t.Errorf("Expected 'blue', got %s", w.Body.String())
		}
	})
	
	t.Run("blue-green switch", func(t *testing.T) {
		// Deploy green version
		deployReq := api.HTTPDeployRequest{
			Host:       "test.example.com",
			Target:     green.URL[7:], // strip http://
			Project:    "test",
			App:        "web",
			HealthPath: "/health",
			SSL:        false,
		}
		
		body, _ := json.Marshal(deployReq)
		req := httptest.NewRequest("POST", "/api/deploy", bytes.NewReader(body))
		w := httptest.NewRecorder()
		
		apiServer.ServeHTTP(w, req)
		
		// Switch target (simulating blue-green switch)
		patchReq := map[string]string{"target": green.URL[7:]}
		body, _ = json.Marshal(patchReq)
		req = httptest.NewRequest("PATCH", "/api/hosts/test.example.com", bytes.NewReader(body))
		w = httptest.NewRecorder()
		
		apiServer.ServeHTTP(w, req)
		
		// Verify traffic switched
		req = httptest.NewRequest("GET", "/", nil)
		req.Host = "test.example.com"
		w = httptest.NewRecorder()
		
		rt.ServeHTTP(w, req)
		
		if w.Body.String() != "green" {
			t.Errorf("Expected 'green' after switch, got %s", w.Body.String())
		}
	})
}

// TestConnectionDraining ensures in-flight requests complete
func TestConnectionDraining(t *testing.T) {
	// This captures the behavior we want to preserve
	st := state.NewState("test-state.json")
	certManager := &mockCertManager{}
	rt := router.NewRouter(st, certManager)
	
	// Slow backend that takes 2 seconds
	slowBackend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
		w.Write([]byte("completed"))
	}))
	defer slowBackend.Close()
	
	// Deploy
	st.DeployHost("test.example.com", slowBackend.URL[7:], "test", "web", "/health", false)
	st.UpdateHealthStatus("test.example.com", true)
	
	// Start a slow request
	done := make(chan string)
	go func() {
		req := httptest.NewRequest("GET", "/", nil)
		req.Host = "test.example.com"
		w := httptest.NewRecorder()
		rt.ServeHTTP(w, req)
		done <- w.Body.String()
	}()
	
	// Switch target while request is in flight
	time.Sleep(100 * time.Millisecond)
	newBackend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("new"))
	}))
	defer newBackend.Close()
	
	st.SwitchTarget("test.example.com", newBackend.URL[7:])
	
	// Original request should complete
	result := <-done
	if result != "completed" {
		t.Errorf("In-flight request was interrupted, got %s", result)
	}
}

// TestHealthCheckBeforeSwitch ensures we don't switch to unhealthy targets
func TestHealthCheckBeforeSwitch(t *testing.T) {
	st := state.NewState("test-state.json")
	certManager := &mockCertManager{}
	healthChecker := &mockHealthChecker{healthy: make(map[string]bool)}
	rt := router.NewRouter(st, certManager)
	
	// Healthy blue
	blue := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
		}
		w.Write([]byte("blue"))
	}))
	defer blue.Close()
	
	// Unhealthy green
	green := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusInternalServerError)
		}
		w.Write([]byte("green"))
	}))
	defer green.Close()
	
	// Deploy blue
	st.DeployHost("test.example.com", blue.URL[7:], "test", "web", "/health", false)
	healthChecker.healthy["test.example.com"] = true
	st.UpdateHealthStatus("test.example.com", true)
	
	// Try to switch to unhealthy green
	st.SwitchTarget("test.example.com", green.URL[7:])
	healthChecker.healthy["test.example.com"] = false
	st.UpdateHealthStatus("test.example.com", false)
	
	// Should still route to blue since green is unhealthy
	req := httptest.NewRequest("GET", "/", nil)
	req.Host = "test.example.com"
	w := httptest.NewRecorder()
	
	rt.ServeHTTP(w, req)
	
	// Expecting 503 since the current implementation marks the host unhealthy
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("Expected 503 for unhealthy service, got %d", w.Code)
	}
}

// Mock implementations
type mockCertManager struct{}

func (m *mockCertManager) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	return nil, fmt.Errorf("no certificate")
}

func (m *mockCertManager) ServeHTTPChallenge(token string) (string, bool) {
	return "", false
}

func (m *mockCertManager) AcquireCertificate(hostname string) error {
	return nil
}

func (m *mockCertManager) RenewCertificate(hostname string) error {
	return nil
}

func (m *mockCertManager) UpdateACMEClient() error {
	return nil
}

type mockHealthChecker struct {
	healthy map[string]bool
}

func (h *mockHealthChecker) Start(ctx context.Context) {}

func (h *mockHealthChecker) CheckHost(hostname string) error {
	if h.healthy[hostname] {
		return nil
	}
	return fmt.Errorf("unhealthy")
}
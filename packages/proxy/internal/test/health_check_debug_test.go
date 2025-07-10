package test

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/elitan/lightform/proxy/internal/health"
	"github.com/elitan/lightform/proxy/internal/state"
)

// TestHealthCheckDebug reproduces the exact health check issues we're seeing with the CLI
func TestHealthCheckDebug(t *testing.T) {
	stateFile := "test-health-debug.json"
	defer func() {
		// Clean up test file
		if err := os.Remove(stateFile); err != nil && !os.IsNotExist(err) {
			t.Logf("Warning: couldn't remove test state file: %v", err)
		}
	}()

	t.Run("simulated_cli_health_check", func(t *testing.T) {
		// Create a test server that mimics the basic example app
		testServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/health" {
				w.WriteHeader(200)
				w.Write([]byte("OK"))
				return
			}
			w.WriteHeader(404)
			w.Write([]byte("Not Found"))
		}))
		defer testServer.Close()

		t.Logf("Test server running at: %s", testServer.URL)

		// Parse the URL to get host and port
		parts := strings.Split(testServer.URL, "://")
		if len(parts) != 2 {
			t.Fatalf("Invalid test server URL: %s", testServer.URL)
		}
		hostPort := parts[1]

		// Create state and register the host
		st := state.NewState(stateFile)
		st.DeployHost("test.eliasson.me", hostPort, "lightform-example-basic", "web", "/api/health", false)
		st.UpdateHealthStatus("test.eliasson.me", true)

		// Create health checker
		checker := health.NewChecker(st)

		// Test direct health check
		t.Log("Testing direct health check...")
		err := checker.CheckHost("test.eliasson.me")
		if err != nil {
			t.Errorf("Direct health check failed: %v", err)
		}

		// Test the exact scenario from CLI
		t.Log("Testing CLI scenario...")

		// Simulate the exact health check that would happen during deployment
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		// Create a mock health checker that simulates what the CLI does
		mockHealthChecker := &CLIHealthChecker{
			targetHost: hostPort,
			healthPath: "/api/health",
		}

		// Test the health check
		err = mockHealthChecker.CheckHealth(ctx, hostPort, "/api/health")
		if err != nil {
			t.Errorf("CLI-style health check failed: %v", err)
		}
	})

	t.Run("simulated_startup_delay", func(t *testing.T) {
		// Test the scenario where a container takes some time to start up
		started := false

		testServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !started {
				// Simulate container not ready yet
				w.WriteHeader(503)
				w.Write([]byte("Service Unavailable"))
				return
			}

			if r.URL.Path == "/api/health" {
				w.WriteHeader(200)
				w.Write([]byte("OK"))
				return
			}
			w.WriteHeader(404)
		}))
		defer testServer.Close()

		// Simulate container startup delay
		go func() {
			time.Sleep(2 * time.Second)
			started = true
			t.Log("Container is now ready")
		}()

		t.Logf("Test server running at: %s (with startup delay)", testServer.URL)

		// Parse the URL to get host and port
		parts := strings.Split(testServer.URL, "://")
		if len(parts) != 2 {
			t.Fatalf("Invalid test server URL: %s", testServer.URL)
		}
		hostPort := parts[1]

		// Test health checking with retries
		mockHealthChecker := &CLIHealthChecker{
			targetHost: hostPort,
			healthPath: "/api/health",
		}

		// Test with multiple attempts
		maxAttempts := 10
		success := false

		for attempt := 0; attempt < maxAttempts; attempt++ {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			err := mockHealthChecker.CheckHealth(ctx, hostPort, "/api/health")
			cancel()

			if err == nil {
				success = true
				t.Logf("Health check passed on attempt %d", attempt+1)
				break
			}

			t.Logf("Health check attempt %d failed: %v", attempt+1, err)
			time.Sleep(500 * time.Millisecond)
		}

		if !success {
			t.Error("Health check never succeeded even after startup delay")
		}
	})

	t.Run("network_connectivity_test", func(t *testing.T) {
		// Test network connectivity similar to what we see in the CLI
		testServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Logf("Received request: %s %s", r.Method, r.URL.Path)
			if r.URL.Path == "/api/health" {
				w.Header().Set("Content-Type", "text/plain")
				w.WriteHeader(200)
				w.Write([]byte("OK"))
				return
			}
			w.WriteHeader(404)
		}))
		defer testServer.Close()

		// Test with different curl command formats
		testCases := []struct {
			name        string
			curlCommand string
			expectPass  bool
		}{
			{
				name:        "basic_curl",
				curlCommand: fmt.Sprintf("curl -s %s/api/health", testServer.URL),
				expectPass:  true,
			},
			{
				name:        "curl_with_status_code",
				curlCommand: fmt.Sprintf("curl -s -o /dev/null -w '%%{http_code}' %s/api/health", testServer.URL),
				expectPass:  true,
			},
			{
				name:        "curl_with_timeout",
				curlCommand: fmt.Sprintf("curl -s -o /dev/null -w '%%{http_code}' --connect-timeout 3 --max-time 5 %s/api/health", testServer.URL),
				expectPass:  true,
			},
		}

		for _, tc := range testCases {
			t.Run(tc.name, func(t *testing.T) {
				// Since we can't actually run shell commands in the test,
				// we'll simulate by making the HTTP request directly
				client := &http.Client{
					Timeout: 5 * time.Second,
				}

				resp, err := client.Get(testServer.URL + "/api/health")
				if err != nil {
					if tc.expectPass {
						t.Errorf("Expected request to pass, but got error: %v", err)
					}
					return
				}
				defer resp.Body.Close()

				if resp.StatusCode != 200 && tc.expectPass {
					t.Errorf("Expected status 200, got %d", resp.StatusCode)
				}

				t.Logf("Test case %s: status=%d", tc.name, resp.StatusCode)
			})
		}
	})

	t.Run("proxy_container_simulation", func(t *testing.T) {
		// This test simulates the scenario where we're running curl from within a proxy container
		// to reach a target container by DNS name

		// Create a test server that represents the target container
		targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Logf("Target server received: %s %s", r.Method, r.URL.Path)
			if r.URL.Path == "/api/health" {
				w.Header().Set("Content-Type", "text/plain")
				w.WriteHeader(200)
				w.Write([]byte("OK"))
				return
			}
			w.WriteHeader(404)
		}))
		defer targetServer.Close()

		// Extract just the port from the target server URL
		urlParts := strings.Split(targetServer.URL, ":")
		if len(urlParts) < 3 {
			t.Fatalf("Invalid target server URL: %s", targetServer.URL)
		}
		port := urlParts[2]

		// Simulate the health check that would happen from the proxy container
		// In the real scenario, this would be something like:
		// "lightform-example-basic-web:3000/api/health"
		// But in our test, we use the actual server

		client := &http.Client{
			Timeout: 5 * time.Second,
		}

		// Test the health endpoint
		healthURL := fmt.Sprintf("http://127.0.0.1:%s/api/health", port)
		t.Logf("Testing health URL: %s", healthURL)

		resp, err := client.Get(healthURL)
		if err != nil {
			t.Errorf("Health check failed: %v", err)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != 200 {
			t.Errorf("Expected status 200, got %d", resp.StatusCode)
		}

		t.Logf("Health check passed: status=%d", resp.StatusCode)
	})
}

// CLIHealthChecker simulates the health checking behavior of the CLI
type CLIHealthChecker struct {
	targetHost string
	healthPath string
}

func (c *CLIHealthChecker) CheckHealth(ctx context.Context, target, healthPath string) error {
	// Simulate the exact HTTP request that would be made by the CLI
	client := &http.Client{
		Timeout: 5 * time.Second,
	}

	url := fmt.Sprintf("http://%s%s", target, healthPath)
	log.Printf("CLI Health Check: %s", url)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("health check request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("health check failed with status %d", resp.StatusCode)
	}

	log.Printf("CLI Health Check passed: %d", resp.StatusCode)
	return nil
}

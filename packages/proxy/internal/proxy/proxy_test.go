package proxy

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestProxyBlueGreen(t *testing.T) {
	// Create proxy
	p := NewProxy(nil)

	// Create backends
	blue := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify headers are set
		if r.Header.Get("X-Forwarded-Host") != "test.com" {
			t.Errorf("Expected X-Forwarded-Host=test.com, got %s", r.Header.Get("X-Forwarded-Host"))
		}
		w.Write([]byte("blue"))
	}))
	defer blue.Close()

	green := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("green"))
	}))
	defer green.Close()

	// Add blue route
	p.UpdateRoute("test.com", blue.Listener.Addr().String(), true)

	// Test blue
	req := httptest.NewRequest("GET", "/test", nil)
	req.Host = "test.com"
	w := httptest.NewRecorder()
	p.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Errorf("Expected 200, got %d", w.Code)
	}
	if w.Body.String() != "blue" {
		t.Errorf("Expected 'blue', got %s", w.Body.String())
	}

	// Switch to green
	p.UpdateRoute("test.com", green.Listener.Addr().String(), true)

	// Test green
	w2 := httptest.NewRecorder()
	p.ServeHTTP(w2, req)

	if w2.Body.String() != "green" {
		t.Errorf("Expected 'green' after switch, got %s", w2.Body.String())
	}

	// Test unhealthy
	p.UpdateRoute("test.com", green.Listener.Addr().String(), false)
	w3 := httptest.NewRecorder()
	p.ServeHTTP(w3, req)

	if w3.Code != http.StatusServiceUnavailable {
		t.Errorf("Expected 503 for unhealthy, got %d", w3.Code)
	}
}

func TestProxyConcurrentSafety(t *testing.T) {
	p := NewProxy(nil)

	// Create backend
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(10 * time.Millisecond) // Simulate work
		w.Write([]byte("ok"))
	}))
	defer backend.Close()

	// Add routes
	for i := 0; i < 10; i++ {
		hostname := fmt.Sprintf("site%d.com", i)
		p.UpdateRoute(hostname, backend.Listener.Addr().String(), true)
	}

	// Concurrent requests and updates
	done := make(chan bool)
	
	// Request workers
	for i := 0; i < 5; i++ {
		go func(id int) {
			for j := 0; j < 20; j++ {
				hostname := fmt.Sprintf("site%d.com", j%10)
				req := httptest.NewRequest("GET", "/", nil)
				req.Host = hostname
				w := httptest.NewRecorder()
				p.ServeHTTP(w, req)
				
				if w.Code != 200 {
					t.Errorf("Worker %d request %d failed: %d", id, j, w.Code)
				}
			}
			done <- true
		}(i)
	}

	// Update worker - just keep everything healthy
	go func() {
		for i := 0; i < 50; i++ {
			hostname := fmt.Sprintf("site%d.com", i%10)
			// Keep all routes healthy during test
			p.UpdateRoute(hostname, backend.Listener.Addr().String(), true)
			time.Sleep(5 * time.Millisecond)
		}
		done <- true
	}()

	// Wait for all workers
	for i := 0; i < 6; i++ {
		<-done
	}
}
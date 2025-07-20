package test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/elitan/iop/proxy/internal/router"
	"github.com/elitan/iop/proxy/internal/state"
)

// TestDebugBlueGreen helps us understand what's happening
func TestDebugBlueGreen(t *testing.T) {
	stateFile := "test-debug.json"
	defer os.Remove(stateFile)

	st := state.NewState(stateFile)
	rt := router.NewFixedRouter(st, nil)

	// Blue backend
	blue := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("blue"))
	}))
	defer blue.Close()
	blueAddr := blue.Listener.Addr().String()
	t.Logf("Blue backend: %s", blueAddr)

	// Green backend
	green := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("green"))
	}))
	defer green.Close()
	greenAddr := green.Listener.Addr().String()
	t.Logf("Green backend: %s", greenAddr)

	// Deploy blue
	err := st.DeployHost("test.com", blueAddr, "test", "web", "/health", false)
	if err != nil {
		t.Fatalf("Failed to deploy: %v", err)
	}
	st.UpdateHealthStatus("test.com", true)

	// Check initial state
	host1, _, _ := st.GetHost("test.com")
	t.Logf("Initial target: %s", host1.Target)

	// Make a request to blue
	req := httptest.NewRequest("GET", "/", nil)
	req.Host = "test.com"
	w := httptest.NewRecorder()
	rt.ServeHTTP(w, req)
	t.Logf("Response 1: %s", w.Body.String())

	// Switch to green
	err = st.SwitchTarget("test.com", greenAddr)
	if err != nil {
		t.Fatalf("Failed to switch: %v", err)
	}

	// Check state after switch
	host2, _, _ := st.GetHost("test.com")
	t.Logf("Target after switch: %s", host2.Target)

	// Make a request after switch
	w2 := httptest.NewRecorder()
	rt.ServeHTTP(w2, req)
	t.Logf("Response 2: %s", w2.Body.String())

	// Make multiple requests to see behavior
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			time.Sleep(time.Duration(n*10) * time.Millisecond)
			
			req := httptest.NewRequest("GET", "/", nil)
			req.Host = "test.com"
			w := httptest.NewRecorder()
			rt.ServeHTTP(w, req)
			
			host, _, _ := st.GetHost("test.com")
			t.Logf("Request %d: response=%s, state_target=%s", n, w.Body.String(), host.Target)
		}(i)
	}
	wg.Wait()
}
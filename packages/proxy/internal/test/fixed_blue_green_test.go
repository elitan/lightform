package test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/elitan/lightform/proxy/internal/router"
	"github.com/elitan/lightform/proxy/internal/state"
)

// TestFixedBlueGreenBehavior tests the fixed router handles blue-green properly
func TestFixedBlueGreenBehavior(t *testing.T) {
	stateFile := "test-fixed-blue-green.json"
	defer os.Remove(stateFile)

	t.Run("atomic traffic switching with fixed router", func(t *testing.T) {
		st := state.NewState(stateFile)
		rt := router.NewFixedRouter(st, nil)

		// Blue backend
		blueCount := int32(0)
		blue := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&blueCount, 1)
			time.Sleep(10 * time.Millisecond) // Simulate some processing
			w.Write([]byte("blue"))
		}))
		defer blue.Close()

		// Green backend
		greenCount := int32(0)
		green := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&greenCount, 1)
			time.Sleep(10 * time.Millisecond) // Simulate some processing
			w.Write([]byte("green"))
		}))
		defer green.Close()

		// Deploy blue
		st.DeployHost("app.example.com", blue.Listener.Addr().String(), "test", "web", "/health", false)
		st.UpdateHealthStatus("app.example.com", true)

		// Start 100 concurrent requests
		var wg sync.WaitGroup
		results := make(chan string, 100)

		for i := 0; i < 100; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				req := httptest.NewRequest("GET", "/", nil)
				req.Host = "app.example.com"
				w := httptest.NewRecorder()
				rt.ServeHTTP(w, req)
				results <- w.Body.String()
			}()
		}

		// After 50ms, switch to green (while requests are in flight)
		time.Sleep(50 * time.Millisecond)
		st.SwitchTarget("app.example.com", green.Listener.Addr().String())

		// Wait for all requests to complete
		wg.Wait()
		close(results)

		// Count results
		blueResponses := 0
		greenResponses := 0
		for result := range results {
			switch result {
			case "blue":
				blueResponses++
			case "green":
				greenResponses++
			}
		}

		// We should have both blue and green responses
		if blueResponses == 0 {
			t.Error("Expected some blue responses, got none")
		}
		if greenResponses == 0 {
			t.Error("Expected some green responses, got none")
		}

		t.Logf("Blue responses: %d, Green responses: %d", blueResponses, greenResponses)
		
		// The responses should show a clear switch pattern
		// Since requests take 10ms and we switch at 50ms, we expect roughly:
		// - First ~50 requests to blue
		// - Remaining ~50 requests to green
		if blueResponses < 30 || blueResponses > 70 {
			t.Errorf("Expected roughly 50 blue responses, got %d", blueResponses)
		}
		if greenResponses < 30 || greenResponses > 70 {
			t.Errorf("Expected roughly 50 green responses, got %d", greenResponses)
		}
	})
}
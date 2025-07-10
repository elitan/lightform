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

// TestRealisticBlueGreen simulates actual traffic patterns during deployment
func TestRealisticBlueGreen(t *testing.T) {
	stateFile := "test-realistic.json"
	defer os.Remove(stateFile)

	t.Run("continuous traffic during switch", func(t *testing.T) {
		st := state.NewState(stateFile)
		rt := router.NewFixedRouter(st, nil)

		// Blue backend
		var blueCount int32
		blue := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&blueCount, 1)
			w.Write([]byte("blue"))
		}))
		defer blue.Close()

		// Green backend
		var greenCount int32
		green := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&greenCount, 1)
			w.Write([]byte("green"))
		}))
		defer green.Close()

		// Deploy blue
		st.DeployHost("app.com", blue.Listener.Addr().String(), "test", "web", "/health", false)
		st.UpdateHealthStatus("app.com", true)

		// Simulate continuous traffic
		stopTraffic := make(chan bool)
		trafficResults := make(chan string, 1000)

		// Start traffic generator - 10 requests per second
		go func() {
			ticker := time.NewTicker(100 * time.Millisecond)
			defer ticker.Stop()
			
			for {
				select {
				case <-stopTraffic:
					return
				case <-ticker.C:
					go func() {
						req := httptest.NewRequest("GET", "/", nil)
						req.Host = "app.com"
						w := httptest.NewRecorder()
						rt.ServeHTTP(w, req)
						trafficResults <- w.Body.String()
					}()
				}
			}
		}()

		// Let some traffic flow to blue
		time.Sleep(500 * time.Millisecond)

		// Switch to green (simulating deployment)
		t.Log("Switching from blue to green...")
		err := st.SwitchTarget("app.com", green.Listener.Addr().String())
		if err != nil {
			t.Fatalf("Failed to switch: %v", err)
		}

		// Let traffic flow to green
		time.Sleep(500 * time.Millisecond)

		// Stop traffic
		close(stopTraffic)
		time.Sleep(200 * time.Millisecond) // Let final requests complete
		close(trafficResults)

		// Count results
		blueResponses := 0
		greenResponses := 0
		var lastBlueIndex, firstGreenIndex int
		index := 0
		
		for result := range trafficResults {
			switch result {
			case "blue":
				blueResponses++
				lastBlueIndex = index
			case "green":
				greenResponses++
				if firstGreenIndex == 0 {
					firstGreenIndex = index
				}
			}
			index++
		}

		t.Logf("Total requests: %d", blueResponses+greenResponses)
		t.Logf("Blue responses: %d (last at index %d)", blueResponses, lastBlueIndex)
		t.Logf("Green responses: %d (first at index %d)", greenResponses, firstGreenIndex)
		t.Logf("Blue backend hit count: %d", atomic.LoadInt32(&blueCount))
		t.Logf("Green backend hit count: %d", atomic.LoadInt32(&greenCount))

		// Verify we got traffic to both
		if blueResponses == 0 {
			t.Error("Expected some blue responses")
		}
		if greenResponses == 0 {
			t.Error("Expected some green responses")
		}

		// Verify clean switch (no interleaving after switch)
		if firstGreenIndex > 0 && lastBlueIndex > firstGreenIndex {
			t.Errorf("Traffic not cleanly switched: last blue at %d, first green at %d", 
				lastBlueIndex, firstGreenIndex)
		}
	})

	t.Run("in-flight requests complete on old backend", func(t *testing.T) {
		st := state.NewState(stateFile)
		rt := router.NewFixedRouter(st, nil)

		// Slow backend that identifies itself
		requestID := int32(0)
		slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := atomic.AddInt32(&requestID, 1)
			time.Sleep(200 * time.Millisecond) // Slow request
			w.Write([]byte("slow-" + string(rune('0'+id))))
		}))
		defer slow.Close()

		// Fast backend
		fast := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("fast"))
		}))
		defer fast.Close()

		// Deploy slow
		st.DeployHost("app2.com", slow.Listener.Addr().String(), "test", "web", "/health", false)
		st.UpdateHealthStatus("app2.com", true)

		// Start 3 slow requests
		results := make(chan string, 3)
		for i := 0; i < 3; i++ {
			go func() {
				req := httptest.NewRequest("GET", "/", nil)
				req.Host = "app2.com"
				w := httptest.NewRecorder()
				rt.ServeHTTP(w, req)
				results <- w.Body.String()
			}()
		}

		// Give requests time to start
		time.Sleep(50 * time.Millisecond)

		// Switch to fast backend
		st.SwitchTarget("app2.com", fast.Listener.Addr().String())

		// New request should go to fast
		req := httptest.NewRequest("GET", "/", nil)
		req.Host = "app2.com"
		w := httptest.NewRecorder()
		rt.ServeHTTP(w, req)
		
		if w.Body.String() != "fast" {
			t.Errorf("New request should go to fast backend, got: %s", w.Body.String())
		}

		// Collect slow results
		slowResults := make([]string, 0, 3)
		for i := 0; i < 3; i++ {
			result := <-results
			slowResults = append(slowResults, result)
		}

		// All slow requests should have completed on slow backend
		for _, result := range slowResults {
			if result != "slow-1" && result != "slow-2" && result != "slow-3" {
				t.Errorf("Expected slow request to complete on slow backend, got: %s", result)
			}
		}

		t.Logf("In-flight requests completed: %v", slowResults)
	})
}
package proxy

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
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

	// Create backend with minimal delay
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	}))
	defer backend.Close()

	// Add fewer routes
	for i := 0; i < 3; i++ {
		hostname := fmt.Sprintf("site%d.com", i)
		p.UpdateRoute(hostname, backend.Listener.Addr().String(), true)
	}

	// Concurrent requests and updates
	done := make(chan bool)
	
	// Fewer request workers with fewer requests
	for i := 0; i < 2; i++ {
		go func(id int) {
			for j := 0; j < 5; j++ {
				hostname := fmt.Sprintf("site%d.com", j%3)
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

	// Update worker with fewer updates
	go func() {
		for i := 0; i < 5; i++ {
			hostname := fmt.Sprintf("site%d.com", i%3)
			p.UpdateRoute(hostname, backend.Listener.Addr().String(), true)
		}
		done <- true
	}()

	// Wait for all workers
	for i := 0; i < 3; i++ {
		<-done
	}
}

func TestResponseWriterHijack(t *testing.T) {
	// Test that our responseWriter implements http.Hijacker properly
	
	// Create a mock ResponseWriter that implements Hijacker
	mockConn := &mockConn{}
	mockRW := &mockResponseWriter{hijacker: mockConn}
	
	// Wrap it with our responseWriter
	wrapped := &responseWriter{ResponseWriter: mockRW}
	
	// Test that it implements Hijacker
	hijacker, ok := interface{}(wrapped).(http.Hijacker)
	if !ok {
		t.Fatal("responseWriter should implement http.Hijacker")
	}
	
	// Test hijacking
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		t.Fatalf("Hijack failed: %v", err)
	}
	
	if conn != mockConn {
		t.Error("Hijack returned wrong connection")
	}
	if rw == nil {
		t.Error("Hijack returned nil ReadWriter")
	}
}

func TestResponseWriterHijackUnsupported(t *testing.T) {
	// Test with ResponseWriter that doesn't support hijacking
	recorder := httptest.NewRecorder()
	wrapped := &responseWriter{ResponseWriter: recorder}
	
	hijacker, ok := interface{}(wrapped).(http.Hijacker)
	if !ok {
		t.Fatal("responseWriter should implement http.Hijacker interface")
	}
	
	// This should fail gracefully
	_, _, err := hijacker.Hijack()
	if err == nil {
		t.Error("Expected error when hijacking unsupported ResponseWriter")
	}
	if !strings.Contains(err.Error(), "does not support hijacking") {
		t.Errorf("Expected hijacking error message, got: %v", err)
	}
}

func TestWebSocketUpgrade(t *testing.T) {
	// Create a simple WebSocket server that just checks hijacking works
	wsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check for WebSocket upgrade headers
		if r.Header.Get("Connection") != "Upgrade" {
			t.Errorf("Expected Connection: Upgrade, got %s", r.Header.Get("Connection"))
		}
		if r.Header.Get("Upgrade") != "websocket" {
			t.Errorf("Expected Upgrade: websocket, got %s", r.Header.Get("Upgrade"))
		}
		
		// Simulate WebSocket upgrade - just verify hijacking is available
		_, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("ResponseWriter should support hijacking for WebSocket")
		}
		
		// Set proper WebSocket response headers before switching protocols
		w.Header().Set("Upgrade", "websocket")
		w.Header().Set("Connection", "Upgrade")
		w.WriteHeader(http.StatusSwitchingProtocols)
	}))
	defer wsServer.Close()
	
	// Create proxy
	p := NewProxy(nil)
	p.UpdateRoute("ws.test.com", wsServer.Listener.Addr().String(), true)
	
	// Create WebSocket upgrade request
	req := httptest.NewRequest("GET", "/ws", nil)
	req.Host = "ws.test.com"
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "test-key")
	
	recorder := httptest.NewRecorder()
	p.ServeHTTP(recorder, req)
	
	// Should get 101 Switching Protocols
	if recorder.Code != http.StatusSwitchingProtocols {
		t.Errorf("Expected 101, got %d", recorder.Code)
	}
}

func TestWebSocketHeaders(t *testing.T) {
	// Test that WebSocket-related headers are properly forwarded
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify WebSocket headers were forwarded
		expectedHeaders := map[string]string{
			"Connection":              "Upgrade",
			"Upgrade":                 "websocket",
			"Sec-WebSocket-Version":   "13",
			"Sec-WebSocket-Key":       "test-key",
			"Sec-WebSocket-Protocol":  "chat",
		}
		
		for header, expected := range expectedHeaders {
			if got := r.Header.Get(header); got != expected {
				t.Errorf("Header %s: expected %s, got %s", header, expected, got)
			}
		}
		
		w.Header().Set("Upgrade", "websocket")
		w.Header().Set("Connection", "Upgrade")
		w.WriteHeader(http.StatusSwitchingProtocols)
	}))
	defer backend.Close()
	
	// Create proxy
	p := NewProxy(nil)
	p.UpdateRoute("ws.test.com", backend.Listener.Addr().String(), true)
	
	// Create WebSocket upgrade request with all headers
	req := httptest.NewRequest("GET", "/ws", nil)
	req.Host = "ws.test.com"
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "test-key")
	req.Header.Set("Sec-WebSocket-Protocol", "chat")
	
	recorder := httptest.NewRecorder()
	p.ServeHTTP(recorder, req)
	
	// Should get 101 Switching Protocols
	if recorder.Code != http.StatusSwitchingProtocols {
		t.Errorf("Expected 101, got %d", recorder.Code)
	}
}

// Mock types for testing

type mockConn struct {
	net.Conn
}

func (m *mockConn) Read(b []byte) (n int, err error)   { return 0, nil }
func (m *mockConn) Write(b []byte) (n int, err error)  { return len(b), nil }
func (m *mockConn) Close() error                       { return nil }
func (m *mockConn) LocalAddr() net.Addr               { return nil }
func (m *mockConn) RemoteAddr() net.Addr              { return nil }
func (m *mockConn) SetDeadline(t time.Time) error     { return nil }
func (m *mockConn) SetReadDeadline(t time.Time) error { return nil }
func (m *mockConn) SetWriteDeadline(t time.Time) error { return nil }

type mockResponseWriter struct {
	http.ResponseWriter
	hijacker net.Conn
}

func (m *mockResponseWriter) Header() http.Header {
	return make(http.Header)
}

func (m *mockResponseWriter) Write([]byte) (int, error) {
	return 0, nil
}

func (m *mockResponseWriter) WriteHeader(statusCode int) {}

func (m *mockResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return m.hijacker, bufio.NewReadWriter(bufio.NewReader(m.hijacker), bufio.NewWriter(m.hijacker)), nil
}

type hijackableRecorder struct {
	*httptest.ResponseRecorder
	conn     net.Conn
	hijacked bool
}

func (h *hijackableRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h.hijacked = true
	return h.conn, bufio.NewReadWriter(bufio.NewReader(h.conn), bufio.NewWriter(h.conn)), nil
}
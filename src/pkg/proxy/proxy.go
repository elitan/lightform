package proxy

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync/atomic"
)

// ReverseProxy handles proxying requests to backend containers
type ReverseProxy struct {
	activeRequests int64
	scaleThreshold int64
	backends       map[string]*httputil.ReverseProxy
}

// New creates a new reverse proxy
func New(scaleThreshold int64) *ReverseProxy {
	return &ReverseProxy{
		activeRequests: 0,
		scaleThreshold: scaleThreshold,
		backends:       make(map[string]*httputil.ReverseProxy),
	}
}

// AddBackend adds a new backend to the proxy
func (p *ReverseProxy) AddBackend(serviceName, targetURL string) error {
	target, err := url.Parse(targetURL)
	if err != nil {
		return err
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	
	// Set up custom error handler
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Host = target.Host
	}

	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("Error proxying request to %s: %v", targetURL, err)
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte("Service unavailable or starting up"))
	}

	p.backends[serviceName] = proxy
	return nil
}

// RemoveBackend removes a backend from the proxy
func (p *ReverseProxy) RemoveBackend(serviceName string) {
	delete(p.backends, serviceName)
}

// ProxyRequest proxies an HTTP request to the specified backend
func (p *ReverseProxy) ProxyRequest(serviceName string, w http.ResponseWriter, r *http.Request) {
	// Increment active requests counter
	atomic.AddInt64(&p.activeRequests, 1)
	defer atomic.AddInt64(&p.activeRequests, -1)

	// Get the backend proxy
	proxy, exists := p.backends[serviceName]
	if !exists {
		http.Error(w, "Service not found", http.StatusNotFound)
		return
	}

	// Proxy the request
	proxy.ServeHTTP(w, r)
}

// GetActiveRequests returns the current count of active requests
func (p *ReverseProxy) GetActiveRequests() int64 {
	return atomic.LoadInt64(&p.activeRequests)
}

// ShouldScale returns true if the current active request count
// exceeds the scaling threshold
func (p *ReverseProxy) ShouldScale() bool {
	return atomic.LoadInt64(&p.activeRequests) >= p.scaleThreshold
}
package proxy

import (
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/elitan/lightform/proxy/internal/core"
)

// Proxy is a clean HTTP proxy that only handles routing
type Proxy struct {
	routes     *RouteTable
	pools      *ConnectionPools
	certProvider core.CertificateProvider
}

// RouteTable manages hostname to route mappings
type RouteTable struct {
	mu     sync.RWMutex
	routes map[string]*core.Route
}

// ConnectionPools manages reverse proxy instances
type ConnectionPools struct {
	mu    sync.RWMutex
	pools map[string]*hostPool // key is hostname
}

type hostPool struct {
	target string
	proxy  *httputil.ReverseProxy
}

// NewProxy creates a new proxy instance
func NewProxy(certProvider core.CertificateProvider) *Proxy {
	return &Proxy{
		routes: &RouteTable{
			routes: make(map[string]*core.Route),
		},
		pools: &ConnectionPools{
			pools: make(map[string]*hostPool),
		},
		certProvider: certProvider,
	}
}

// ServeHTTP handles incoming HTTP requests
func (p *Proxy) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	start := time.Now()

	// Handle ACME challenges
	if strings.HasPrefix(req.URL.Path, "/.well-known/acme-challenge/") {
		p.handleACMEChallenge(w, req)
		return
	}

	// Get route
	route := p.routes.Get(req.Host)
	if route == nil {
		log.Printf("[PROXY] %s %s %s -> 404 (no route)", req.Host, req.Method, req.URL.Path)
		http.NotFound(w, req)
		return
	}

	// Check health
	if !route.Healthy {
		log.Printf("[PROXY] %s %s %s -> 503 (unhealthy)", req.Host, req.Method, req.URL.Path)
		http.Error(w, "Service Unavailable", http.StatusServiceUnavailable)
		return
	}

	// Get or create proxy
	proxy := p.pools.GetOrCreate(route.Hostname, route.Target)

	// Set forwarding headers
	p.setForwardingHeaders(req)

	// Create response wrapper to capture status
	wrapped := &responseWriter{ResponseWriter: w}

	// Proxy the request
	proxy.ServeHTTP(wrapped, req)

	// Log the request
	duration := time.Since(start)
	log.Printf("[PROXY] %s %s %s -> %s %d (%dms)",
		req.Host, req.Method, req.URL.Path, route.Target, wrapped.statusCode, duration.Milliseconds())
}

// UpdateRoute updates or adds a route
func (p *Proxy) UpdateRoute(hostname, target string, healthy bool) {
	p.routes.Set(hostname, &core.Route{
		Hostname: hostname,
		Target:   target,
		Healthy:  healthy,
	})
}

// RemoveRoute removes a route
func (p *Proxy) RemoveRoute(hostname string) {
	p.routes.Delete(hostname)
	p.pools.Delete(hostname)
}

// handleACMEChallenge handles Let's Encrypt challenges
func (p *Proxy) handleACMEChallenge(w http.ResponseWriter, req *http.Request) {
	if p.certProvider == nil {
		http.NotFound(w, req)
		return
	}

	token := strings.TrimPrefix(req.URL.Path, "/.well-known/acme-challenge/")
	if keyAuth, ok := p.certProvider.ServeHTTPChallenge(token); ok {
		log.Printf("[ACME] [%s] Challenge served for token: %s", req.Host, token)
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte(keyAuth))
		return
	}

	log.Printf("[ACME] [%s] Unknown challenge token: %s", req.Host, token)
	http.NotFound(w, req)
}

// setForwardingHeaders sets standard proxy headers
func (p *Proxy) setForwardingHeaders(req *http.Request) {
	clientIP := p.getClientIP(req)
	req.Header.Set("X-Real-IP", clientIP)
	req.Header.Set("X-Forwarded-For", clientIP)
	req.Header.Set("X-Forwarded-Host", req.Host)
	
	if req.TLS != nil {
		req.Header.Set("X-Forwarded-Proto", "https")
	} else {
		req.Header.Set("X-Forwarded-Proto", "http")
	}
}

// getClientIP extracts the real client IP
func (p *Proxy) getClientIP(req *http.Request) string {
	// Check X-Forwarded-For first
	if xff := req.Header.Get("X-Forwarded-For"); xff != "" {
		ips := strings.Split(xff, ",")
		if len(ips) > 0 {
			return strings.TrimSpace(ips[0])
		}
	}

	// Check X-Real-IP
	if xrip := req.Header.Get("X-Real-IP"); xrip != "" {
		return xrip
	}

	// Fall back to RemoteAddr
	ip, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		return req.RemoteAddr
	}
	return ip
}

// RouteTable methods

func (rt *RouteTable) Get(hostname string) *core.Route {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	return rt.routes[hostname]
}

func (rt *RouteTable) Set(hostname string, route *core.Route) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.routes[hostname] = route
}

func (rt *RouteTable) Delete(hostname string) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	delete(rt.routes, hostname)
}

// ConnectionPools methods

func (cp *ConnectionPools) GetOrCreate(hostname, target string) *httputil.ReverseProxy {
	cp.mu.RLock()
	pool, exists := cp.pools[hostname]
	if exists && pool.target == target {
		cp.mu.RUnlock()
		return pool.proxy
	}
	cp.mu.RUnlock()

	// Need to create or update
	cp.mu.Lock()
	defer cp.mu.Unlock()

	// Double-check
	pool, exists = cp.pools[hostname]
	if exists && pool.target == target {
		return pool.proxy
	}

	// Create new proxy
	proxy := cp.createProxy(target)
	cp.pools[hostname] = &hostPool{
		target: target,
		proxy:  proxy,
	}

	return proxy
}

func (cp *ConnectionPools) Delete(hostname string) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	delete(cp.pools, hostname)
}

func (cp *ConnectionPools) createProxy(target string) *httputil.ReverseProxy {
	targetURL, err := url.Parse("http://" + target)
	if err != nil {
		log.Printf("[PROXY] Failed to parse target URL %s: %v", target, err)
		// Return error proxy
		return &httputil.ReverseProxy{
			Director: func(req *http.Request) {
				req.URL = nil
			},
		}
	}

	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	
	// Configure transport
	proxy.Transport = &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		MaxIdleConnsPerHost:   10,
	}

	// Error handler
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("[PROXY] Error proxying to %s: %v", target, err)
		http.Error(w, "Bad Gateway", http.StatusBadGateway)
	}

	return proxy
}

// responseWriter wraps http.ResponseWriter to capture status code
type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (w *responseWriter) WriteHeader(code int) {
	w.statusCode = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *responseWriter) Write(b []byte) (int, error) {
	if w.statusCode == 0 {
		w.statusCode = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}
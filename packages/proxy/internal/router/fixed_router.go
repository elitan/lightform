package router

import (
	"crypto/tls"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/elitan/lightform/proxy/internal/state"
)

// FixedRouter is a version that properly handles blue-green deployments
type FixedRouter struct {
	state       *state.State
	certManager CertificateProvider
	
	// Instead of caching by target, cache by hostname
	proxiesMu sync.RWMutex
	proxies   map[string]*hostProxy
}

type hostProxy struct {
	target string
	proxy  *httputil.ReverseProxy
}

// NewFixedRouter creates a router that properly handles target switches
func NewFixedRouter(st *state.State, cm CertificateProvider) *FixedRouter {
	return &FixedRouter{
		state:       st,
		certManager: cm,
		proxies:     make(map[string]*hostProxy),
	}
}

func (r *FixedRouter) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	start := time.Now()

	// Handle ACME challenges
	if strings.HasPrefix(req.URL.Path, "/.well-known/acme-challenge/") {
		if r.certManager == nil {
			http.NotFound(w, req)
			return
		}
		token := strings.TrimPrefix(req.URL.Path, "/.well-known/acme-challenge/")
		if keyAuth, ok := r.certManager.ServeHTTPChallenge(token); ok {
			log.Printf("[ACME] [%s] Let's Encrypt validation request: GET %s", req.Host, req.URL.Path)
			w.Header().Set("Content-Type", "text/plain")
			w.Write([]byte(keyAuth))
			log.Printf("[ACME] [%s] Challenge response served: 200 OK", req.Host)
			return
		}
		log.Printf("[ACME] [%s] Unknown challenge token: %s", req.Host, token)
		http.NotFound(w, req)
		return
	}

	// Get host configuration
	host, _, err := r.state.GetHost(req.Host)
	if err != nil {
		log.Printf("[PROXY] %s %s %s -> 404 (host not found)", req.Host, req.Method, req.URL.Path)
		http.NotFound(w, req)
		return
	}

	// Check if SSL redirect is enabled and this is HTTP
	if host.SSLRedirect && req.TLS == nil {
		httpsURL := "https://" + req.Host + req.URL.RequestURI()
		http.Redirect(w, req, httpsURL, http.StatusMovedPermanently)
		log.Printf("[PROXY] %s %s %s -> 301 (HTTPS redirect)", req.Host, req.Method, req.URL.Path)
		return
	}

	// Check health status
	if !host.Healthy {
		log.Printf("[PROXY] %s %s %s -> 503 (unhealthy)", req.Host, req.Method, req.URL.Path)
		http.Error(w, "Service Unavailable", http.StatusServiceUnavailable)
		return
	}

	// Get or create proxy for this hostname
	proxy := r.getOrCreateProxy(req.Host, host.Target)

	// Set forwarding headers
	if host.ForwardHeaders {
		req.Header.Set("X-Real-IP", r.getClientIP(req))
		req.Header.Set("X-Forwarded-For", r.getClientIP(req))
		req.Header.Set("X-Forwarded-Proto", r.getProto(req))
		req.Header.Set("X-Forwarded-Host", req.Host)
	}

	// Create response writer wrapper to capture status code
	wrapped := &responseWriter{ResponseWriter: w}

	// Proxy the request
	proxy.ServeHTTP(wrapped, req)

	// Log the request
	duration := time.Since(start)
	log.Printf("[PROXY] %s %s %s -> %s %d (%dms)",
		req.Host, req.Method, req.URL.Path, host.Target, wrapped.statusCode, duration.Milliseconds())
}

// getOrCreateProxy returns a reverse proxy for the given hostname
func (r *FixedRouter) getOrCreateProxy(hostname, target string) *httputil.ReverseProxy {
	r.proxiesMu.RLock()
	hp, exists := r.proxies[hostname]
	if exists && hp.target == target {
		r.proxiesMu.RUnlock()
		return hp.proxy
	}
	r.proxiesMu.RUnlock()

	// Need to create new proxy or target changed
	r.proxiesMu.Lock()
	defer r.proxiesMu.Unlock()

	// Double-check in case another goroutine created it
	hp, exists = r.proxies[hostname]
	if exists && hp.target == target {
		return hp.proxy
	}

	// Create new proxy
	targetURL, err := url.Parse("http://" + target)
	if err != nil {
		log.Printf("[PROXY] Failed to parse target URL %s: %v", target, err)
		// Return a proxy that always returns an error
		return &httputil.ReverseProxy{
			Director: func(req *http.Request) {
				req.URL = nil // This will cause the proxy to return an error
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

	// Custom error handler
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("[PROXY] Error proxying to %s: %v", target, err)
		http.Error(w, "Bad Gateway", http.StatusBadGateway)
	}

	// Custom modify response to handle errors
	proxy.ModifyResponse = func(resp *http.Response) error {
		if resp.StatusCode >= 500 {
			log.Printf("[PROXY] Upstream error from %s: %d", target, resp.StatusCode)
		}
		return nil
	}

	// Store the new proxy
	r.proxies[hostname] = &hostProxy{
		target: target,
		proxy:  proxy,
	}

	return proxy
}

// GetTLSConfig returns the TLS configuration for HTTPS
func (r *FixedRouter) GetTLSConfig() *tls.Config {
	config := &tls.Config{
		MinVersion:     tls.VersionTLS12,
		CipherSuites: []uint16{
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		},
		PreferServerCipherSuites: true,
	}
	
	if r.certManager != nil {
		config.GetCertificate = r.certManager.GetCertificate
	}
	
	return config
}

// getClientIP extracts the client IP from the request
func (r *FixedRouter) getClientIP(req *http.Request) string {
	// Check X-Forwarded-For header first
	if xff := req.Header.Get("X-Forwarded-For"); xff != "" {
		ips := strings.Split(xff, ",")
		if len(ips) > 0 {
			return strings.TrimSpace(ips[0])
		}
	}

	// Check X-Real-IP header
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

// getProto returns the protocol (http or https)
func (r *FixedRouter) getProto(req *http.Request) string {
	if req.TLS != nil {
		return "https"
	}

	// Check X-Forwarded-Proto header
	if proto := req.Header.Get("X-Forwarded-Proto"); proto != "" {
		return proto
	}

	return "http"
}
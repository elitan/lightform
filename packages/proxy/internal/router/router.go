package router

import (
	"crypto/tls"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/elitan/luma/proxy/internal/cert"
	"github.com/elitan/luma/proxy/internal/state"
)

type Router struct {
	state       *state.State
	certManager *cert.Manager
	proxies     map[string]*httputil.ReverseProxy
}

// NewRouter creates a new router instance
func NewRouter(st *state.State, cm *cert.Manager) *Router {
	return &Router{
		state:       st,
		certManager: cm,
		proxies:     make(map[string]*httputil.ReverseProxy),
	}
}

// ServeHTTP handles incoming HTTP requests
func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	start := time.Now()

	// Handle ACME challenges
	if strings.HasPrefix(req.URL.Path, "/.well-known/acme-challenge/") {
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

	// Get or create proxy
	proxy := r.getOrCreateProxy(host.Target)

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

// GetTLSConfig returns the TLS configuration for HTTPS
func (r *Router) GetTLSConfig() *tls.Config {
	return &tls.Config{
		GetCertificate: r.certManager.GetCertificate,
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
}

// getOrCreateProxy returns a reverse proxy for the given target
func (r *Router) getOrCreateProxy(target string) *httputil.ReverseProxy {
	if proxy, exists := r.proxies[target]; exists {
		return proxy
	}

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

	r.proxies[target] = proxy
	return proxy
}

// getClientIP extracts the client IP from the request
func (r *Router) getClientIP(req *http.Request) string {
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
func (r *Router) getProto(req *http.Request) string {
	if req.TLS != nil {
		return "https"
	}

	// Check X-Forwarded-Proto header
	if proto := req.Header.Get("X-Forwarded-Proto"); proto != "" {
		return proto
	}

	return "http"
}

// responseWriter wraps http.ResponseWriter to capture status code
type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (w *responseWriter) WriteHeader(statusCode int) {
	w.statusCode = statusCode
	w.ResponseWriter.WriteHeader(statusCode)
}

func (w *responseWriter) Write(b []byte) (int, error) {
	if w.statusCode == 0 {
		w.statusCode = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

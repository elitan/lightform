package proxy

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/elitan/luma-proxy/internal/cert"
	"github.com/elitan/luma-proxy/internal/service"
	"github.com/elitan/luma-proxy/pkg/models"
)

// BackendCache represents a cached backend resolution
type BackendCache struct {
	Target    string
	ExpiresAt time.Time
}

// Server represents the proxy server
type Server struct {
	httpsPort      string
	serviceManager *service.Manager
	certManager    *cert.Manager
	certConfig     models.CertConfig
	backendCache   map[string]BackendCache // Cache key: "project:hostname:port"
	cacheMutex     sync.RWMutex
}

// NewServer creates a new proxy server
func NewServer(httpsPort string, serviceManager *service.Manager, certConfig models.CertConfig) *Server {
	server := &Server{
		httpsPort:      httpsPort,
		serviceManager: serviceManager,
		certConfig:     certConfig,
		backendCache:   make(map[string]BackendCache),
	}

	// Initialize the certificate manager
	log.Println("Setting up automatic Let's Encrypt certificate management")
	server.certManager = cert.NewManager(certConfig.Email)

	// Add all known domains to the certificate manager
	for _, svc := range serviceManager.GetAllServices() {
		server.certManager.AddDomain(svc.Host)
	}

	// Start cache cleanup routine
	go server.startCacheCleanupRoutine()

	return server
}

// startCacheCleanupRoutine starts a background routine to clean expired cache entries
func (s *Server) startCacheCleanupRoutine() {
	ticker := time.NewTicker(60 * time.Second) // Clean every minute
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			s.cleanExpiredCacheEntries()
		}
	}
}

// cleanExpiredCacheEntries removes expired entries from the cache
func (s *Server) cleanExpiredCacheEntries() {
	s.cacheMutex.Lock()
	defer s.cacheMutex.Unlock()

	now := time.Now()
	for key, cache := range s.backendCache {
		if now.After(cache.ExpiresAt) {
			delete(s.backendCache, key)
		}
	}
}

// getCachedBackend retrieves a cached backend or returns empty string if not found/expired
func (s *Server) getCachedBackend(cacheKey string) string {
	s.cacheMutex.RLock()
	defer s.cacheMutex.RUnlock()

	cache, exists := s.backendCache[cacheKey]
	if !exists || time.Now().After(cache.ExpiresAt) {
		return ""
	}

	return cache.Target
}

// setCachedBackend stores a backend in the cache with 30-second TTL
func (s *Server) setCachedBackend(cacheKey, target string) {
	s.cacheMutex.Lock()
	defer s.cacheMutex.Unlock()

	s.backendCache[cacheKey] = BackendCache{
		Target:    target,
		ExpiresAt: time.Now().Add(30 * time.Second), // 30s TTL for blue-green switches
	}
}

// Start starts the proxy server
func (s *Server) Start() error {
	log.Println("Starting Luma proxy server...")

	// Start HTTPS server in a goroutine
	go s.startHTTPSServer()

	// Start HTTP server for redirects and ACME challenges
	return s.startHTTPServer()
}

// startHTTPSServer starts the HTTPS server
func (s *Server) startHTTPSServer() {
	httpsMux := http.NewServeMux()

	// Main handler for all routes
	httpsMux.HandleFunc("/", s.handleHTTPSRequest)

	// Test endpoint
	httpsMux.HandleFunc("/luma-proxy/test", func(w http.ResponseWriter, r *http.Request) {
		log.Printf("HTTPS: Received request for /luma-proxy/test endpoint from %s\n", r.RemoteAddr)
		fmt.Fprintf(w, "Luma Proxy (HTTPS): /luma-proxy/test endpoint is working!")
	})

	// Health check endpoint for the proxy itself
	httpsMux.HandleFunc("/luma-proxy/health", func(w http.ResponseWriter, r *http.Request) {
		log.Printf("HTTPS: Received request for proxy health check from %s\n", r.RemoteAddr)
		fmt.Fprintf(w, "OK")
	})

	// Health check endpoint for target services
	httpsMux.HandleFunc("/luma-proxy/check-target", s.handleHealthCheck)

	log.Printf("Luma Proxy daemon starting HTTPS listener on port %s", s.httpsPort)

	// Get TLS config from cert manager for automatic certificates
	tlsConfig := s.certManager.GetTLSConfig()
	server := &http.Server{
		Addr:      ":" + s.httpsPort,
		Handler:   httpsMux,
		TLSConfig: tlsConfig,
	}

	// ListenAndServeTLS with empty strings uses the certificates from the TLS config
	if err := server.ListenAndServeTLS("", ""); err != nil {
		log.Fatalf("Failed to start HTTPS server: %s\n", err)
	}
}

// startHTTPServer starts the HTTP server for redirects and ACME challenges
func (s *Server) startHTTPServer() error {
	// The HTTP handler from cert manager handles ACME challenges
	// and falls back to our redirect handler for other requests
	httpHandler := s.certManager.HTTPHandler(http.HandlerFunc(s.handleHTTPRedirect))
	httpMux := http.NewServeMux()
	httpMux.Handle("/", httpHandler)

	log.Printf("Luma Proxy daemon starting HTTP listener on port 80")
	return http.ListenAndServe(":80", httpMux)
}

// handleHTTPSRequest handles HTTPS requests and routes them to the appropriate service
func (s *Server) handleHTTPSRequest(w http.ResponseWriter, r *http.Request) {
	host := strings.Split(r.Host, ":")[0] // Remove port if present
	log.Printf("HTTPS: Received request for host: %s, path: %s from %s\n", host, r.URL.Path, r.RemoteAddr)

	// If it's a request for the proxy itself (endpoints under /luma-proxy/)
	if strings.HasPrefix(r.URL.Path, "/luma-proxy/") {
		return // Let the specific handlers take care of it
	}

	// Find service for this host
	targetService, found := s.serviceManager.FindByHost(host)
	if !found {
		// No service found for this host
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprintf(w, "Luma Proxy: No service configured for host: %s", host)
		return
	}

	// Check if service is healthy
	if !targetService.Healthy {
		log.Printf("Service %s is unhealthy, returning 503", targetService.Name)
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprintf(w, "Luma Proxy: Service temporarily unavailable")
		return
	}

	// Route to network alias (Docker handles load balancing for blue-green deployments)
	s.routeToTarget(w, r, targetService)
}

// NetworkContainerInfo represents container information in a Docker network
type NetworkContainerInfo struct {
	Name        string `json:"Name"`
	IPv4Address string `json:"IPv4Address"`
}

// NetworkInspectResult represents the result of docker network inspect
type NetworkInspectResult struct {
	Containers map[string]NetworkContainerInfo `json:"Containers"`
}

// resolveBackendIP resolves the IP address of a backend service within its project network
func (s *Server) resolveBackendIP(service models.Service) (string, error) {
	// Parse the target to extract hostname and port
	parts := strings.Split(service.Target, ":")
	if len(parts) != 2 {
		return "", fmt.Errorf("invalid target format: %s (expected hostname:port)", service.Target)
	}

	hostname := parts[0]
	port := parts[1]

	// Get the project network name
	projectNetworkName := fmt.Sprintf("%s-network", service.Project)

	// Inspect the project network to find containers with the hostname alias
	cmd := exec.Command("docker", "network", "inspect", projectNetworkName)
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to inspect network %s: %v", projectNetworkName, err)
	}

	var networks []NetworkInspectResult
	if err := json.Unmarshal(output, &networks); err != nil {
		return "", fmt.Errorf("failed to parse network inspect result: %v", err)
	}

	if len(networks) == 0 {
		return "", fmt.Errorf("network %s not found", projectNetworkName)
	}

	network := networks[0]

	// Find containers in this network and check which ones have the hostname alias
	for containerID, containerInfo := range network.Containers {
		// Get the container's aliases in this network
		aliasCmd := exec.Command("docker", "inspect", containerID,
			"--format", fmt.Sprintf("{{range $net, $conf := .NetworkSettings.Networks}}{{if eq $net \"%s\"}}{{range $conf.Aliases}}{{.}} {{end}}{{end}}{{end}}", projectNetworkName))
		aliasOutput, err := aliasCmd.Output()
		if err != nil {
			log.Printf("Failed to get aliases for container %s: %v", containerID, err)
			continue
		}

		aliases := strings.Fields(strings.TrimSpace(string(aliasOutput)))
		for _, alias := range aliases {
			if alias == hostname {
				// This container has the hostname alias, use its IP
				// Extract just the IP address (remove /subnet if present)
				ipAddr := strings.Split(containerInfo.IPv4Address, "/")[0]
				resolvedTarget := fmt.Sprintf("%s:%s", ipAddr, port)
				log.Printf("Resolved %s in project %s to %s (container: %s)", service.Target, service.Project, resolvedTarget, containerInfo.Name)
				return resolvedTarget, nil
			}
		}
	}

	return "", fmt.Errorf("no container found with alias %s in network %s", hostname, projectNetworkName)
}

// routeToTarget routes requests to the service target using cached project-aware IP resolution
func (s *Server) routeToTarget(w http.ResponseWriter, r *http.Request, service models.Service) {
	// Create cache key
	cacheKey := fmt.Sprintf("%s:%s", service.Project, service.Target)

	// Try to get cached backend first
	resolvedTarget := s.getCachedBackend(cacheKey)

	// If not cached or expired, resolve backend IP
	if resolvedTarget == "" {
		var err error
		resolvedTarget, err = s.resolveBackendIP(service)
		if err != nil {
			log.Printf("Error resolving backend for service %s: %v", service.Name, err)
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprintf(w, "Luma Proxy: Error resolving backend")
			return
		}

		// Cache the result
		s.setCachedBackend(cacheKey, resolvedTarget)
		log.Printf("Cached backend resolution for %s: %s", cacheKey, resolvedTarget)
	}

	// Parse the resolved target URL (IP:port)
	targetURL, err := url.Parse("http://" + resolvedTarget)
	if err != nil {
		log.Printf("Error parsing resolved target URL for service %s: %v", service.Name, err)
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, "Luma Proxy: Error routing request")
		return
	}

	// Create a reverse proxy
	proxy := httputil.NewSingleHostReverseProxy(targetURL)

	// Update the request's Host header to match the target's host
	r.Host = targetURL.Host

	// Proxy the request to the resolved IP (project-aware backend resolution with caching)
	proxy.ServeHTTP(w, r)
}

// handleHealthCheck handles requests to check the health of a target service
func (s *Server) handleHealthCheck(w http.ResponseWriter, r *http.Request) {
	// Get parameters from query string
	targetParam := r.URL.Query().Get("target")
	pathParam := r.URL.Query().Get("path")
	projectParam := r.URL.Query().Get("project")

	// Default path to /up if not specified
	if pathParam == "" {
		pathParam = "/up"
	}

	if targetParam == "" {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprintf(w, "Error: Missing required 'target' parameter")
		return
	}

	if projectParam == "" {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprintf(w, "Error: Missing required 'project' parameter for project-aware health check")
		return
	}

	log.Printf("Health check request for target %s in project %s, path %s", targetParam, projectParam, pathParam)

	// Create a temporary service object for resolution
	tempService := models.Service{
		Target:  targetParam,
		Project: projectParam,
	}

	// Create cache key and try cached resolution first
	cacheKey := fmt.Sprintf("%s:%s", projectParam, targetParam)
	resolvedTarget := s.getCachedBackend(cacheKey)

	// If not cached, resolve backend IP using project context
	if resolvedTarget == "" {
		var err error
		resolvedTarget, err = s.resolveBackendIP(tempService)
		if err != nil {
			log.Printf("Health check failed - could not resolve backend for %s in project %s: %v", targetParam, projectParam, err)
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprintf(w, "Health check failed: Could not resolve backend - %v", err)
			return
		}

		// Cache the result
		s.setCachedBackend(cacheKey, resolvedTarget)
	}

	// Build the URL to check using resolved IP
	targetURL := fmt.Sprintf("http://%s%s", resolvedTarget, pathParam)

	// Execute curl command to check service health
	// Using curl with timeout options for reliability
	cmd := exec.Command("curl", "-s", "-f", "--max-time", "10", targetURL)
	output, err := cmd.CombinedOutput()

	if err != nil {
		log.Printf("Health check failed for %s (resolved: %s): %v", targetParam, resolvedTarget, err)
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprintf(w, "Health check failed: %s", string(output))
		return
	}

	log.Printf("Health check succeeded for %s (resolved: %s)", targetParam, resolvedTarget)
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "OK")
}

// handleHTTPRedirect redirects HTTP requests to HTTPS
func (s *Server) handleHTTPRedirect(w http.ResponseWriter, r *http.Request) {
	requestHost := r.Host // This is the content of the Host header

	// Attempt to split host and port; if error, assume requestHost is just the hostname
	hostOnly, _, err := net.SplitHostPort(requestHost)
	if err != nil {
		hostOnly = requestHost
	}

	// Construct the target host: use hostOnly, and add httpsPort if it's not the standard 443
	targetHost := hostOnly
	if s.httpsPort != "443" {
		targetHost = net.JoinHostPort(hostOnly, s.httpsPort)
	}

	targetURL := &url.URL{
		Scheme:   "https",
		Host:     targetHost,
		Path:     r.URL.Path,
		RawQuery: r.URL.RawQuery,
	}

	log.Printf("HTTP: Redirecting request from %s (Host: %s, URI: %s) to %s\n", r.RemoteAddr, r.Host, r.RequestURI, targetURL.String())
	http.Redirect(w, r, targetURL.String(), http.StatusMovedPermanently)
}

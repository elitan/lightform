package proxy

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/elitan/luma-proxy/internal/cert"
	"github.com/elitan/luma-proxy/internal/service"
	"github.com/elitan/luma-proxy/pkg/models"
)

// Server represents the proxy server
type Server struct {
	httpsPort      string
	serviceManager *service.Manager
	certManager    *cert.Manager
	certConfig     models.CertConfig
}

// NewServer creates a new proxy server
func NewServer(httpsPort string, serviceManager *service.Manager, certConfig models.CertConfig) *Server {
	server := &Server{
		httpsPort:      httpsPort,
		serviceManager: serviceManager,
		certConfig:     certConfig,
	}

	// Initialize the certificate manager
	log.Println("Setting up automatic Let's Encrypt certificate management")
	server.certManager = cert.NewManager(certConfig.Email)

	// Add all known domains to the certificate manager
	allServices := serviceManager.GetAllServices()
	for _, svc := range allServices {
		server.certManager.AddDomain(svc.Host)
		log.Printf("Pre-configured SSL domain: %s", svc.Host)
	}

	if len(allServices) == 0 {
		log.Printf("No domains configured yet - SSL certificates will be added as domains are deployed")
	}

	return server
}

// ReloadCertificateDomains reloads all domains from the service manager into the certificate manager
func (s *Server) ReloadCertificateDomains() {
	allServices := s.serviceManager.GetAllServices()
	for _, svc := range allServices {
		s.certManager.AddDomain(svc.Host)
	}
}

// Start starts the proxy server
func (s *Server) Start() error {
	log.Println("Starting Luma proxy server...")

	// Start certificate domain reload monitoring
	go s.monitorCertificateReloadTrigger()

	// Start HTTPS server in a goroutine
	go s.startHTTPSServer()

	// Start HTTP server for redirects and ACME challenges
	return s.startHTTPServer()
}

// monitorCertificateReloadTrigger monitors for certificate reload triggers and updates the certificate manager
func (s *Server) monitorCertificateReloadTrigger() {
	triggerFile := "/tmp/luma-proxy-cert-reload-trigger"
	var lastModTime int64

	log.Printf("Starting certificate domain reload monitoring...")

	// Check for trigger file changes every 2 seconds
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			// Check if trigger file exists and has been modified
			if info, err := os.Stat(triggerFile); err == nil {
				modTime := info.ModTime().Unix()
				if modTime > lastModTime {
					lastModTime = modTime
					log.Printf("Certificate reload trigger detected - reloading certificate domains...")

					// Reload all domains from configuration into certificate manager
					s.ReloadCertificateDomains()

					log.Printf("✅ Certificate domains reloaded for immediate SSL provisioning")
				}
			}
		}
	}
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

	// Reload certificate domains to ensure newly deployed domains are in the certificate manager
	// This ensures SSL certificates can be provisioned for domains deployed after server startup
	s.ReloadCertificateDomains()

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

// routeToTarget routes requests to the service target using network-scoped DNS resolution
func (s *Server) routeToTarget(w http.ResponseWriter, r *http.Request, service models.Service) {
	log.Printf("Routing request for %s (project: %s) to target: %s",
		service.Host, service.Project, service.Target)

	// Use network-scoped DNS resolution instead of IP-based resolution
	// This leverages Docker's built-in service discovery and load balancing
	targetURL, err := url.Parse("http://" + service.Target)
	if err != nil {
		log.Printf("Error parsing target URL for service %s: %v", service.Name, err)
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, "Luma Proxy: Error routing request")
		return
	}

	// Create a reverse proxy that will use Docker's network-scoped DNS
	proxy := httputil.NewSingleHostReverseProxy(targetURL)

	// Configure the director to preserve the original Host header for the backend
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		// Keep the original Host header so the backend application receives the correct hostname
		req.Host = r.Host
		log.Printf("Proxying %s request to %s (network-scoped DNS, project: %s)",
			req.Method, req.URL.String(), service.Project)
	}

	// Configure error handler for better debugging
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("Proxy error for service %s (project: %s, target: %s): %v",
			service.Name, service.Project, service.Target, err)
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprintf(w, "Luma Proxy: Backend connection failed")
	}

	// Proxy the request using Docker's network-scoped DNS resolution
	// Docker will automatically load balance between containers with the same alias
	proxy.ServeHTTP(w, r)
}

// handleHealthCheck handles requests to check the health of a target service using network-scoped DNS
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

	log.Printf("Network-scoped health check request for target %s in project %s, path %s", targetParam, projectParam, pathParam)

	// Perform health check using network-scoped DNS resolution
	targetURL := fmt.Sprintf("http://%s%s", targetParam, pathParam)

	// Execute curl command from within the luma-proxy container for network-scoped DNS
	cmd := exec.Command("docker", "exec", "luma-proxy",
		"curl", "-s", "-f", "--max-time", "10", "--connect-timeout", "5", targetURL)

	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("Network-scoped health check failed for %s in project %s: %v - output: %s",
			targetParam, projectParam, err, string(output))
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprintf(w, "Health check failed: %v\nOutput: %s", err, string(output))
		return
	}

	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "Health check passed for %s in project %s\nOutput: %s", targetParam, projectParam, string(output))
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

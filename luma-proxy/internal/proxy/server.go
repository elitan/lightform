package proxy

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os/exec"
	"strings"

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
	for _, svc := range serviceManager.GetAllServices() {
		server.certManager.AddDomain(svc.Host)
	}

	return server
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

	// Parse the target URL
	targetURL, err := url.Parse("http://" + targetService.Target)
	if err != nil {
		log.Printf("Error parsing target URL for service %s: %v", targetService.Name, err)
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, "Luma Proxy: Error routing request")
		return
	}

	// Create a reverse proxy
	proxy := httputil.NewSingleHostReverseProxy(targetURL)

	// Update the request's Host header to match the target's host
	r.Host = targetURL.Host

	// Proxy the request
	log.Printf("HTTPS: Routing request to service %s at %s", targetService.Name, targetService.Target)
	proxy.ServeHTTP(w, r)
}

// handleHealthCheck handles requests to check the health of a target service
func (s *Server) handleHealthCheck(w http.ResponseWriter, r *http.Request) {
	// Get parameters from query string
	targetParam := r.URL.Query().Get("target")
	pathParam := r.URL.Query().Get("path")

	// Default path to /up if not specified
	if pathParam == "" {
		pathParam = "/up"
	}

	if targetParam == "" {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprintf(w, "Error: Missing required 'target' parameter")
		return
	}

	log.Printf("Health check request for target %s, path %s", targetParam, pathParam)

	// Build the URL to check
	targetURL := fmt.Sprintf("http://%s%s", targetParam, pathParam)

	// Execute curl command to check service health
	// Using curl with timeout options for reliability
	cmd := exec.Command("curl", "-s", "-f", "--max-time", "10", targetURL)
	output, err := cmd.CombinedOutput()

	if err != nil {
		log.Printf("Health check failed for %s: %v", targetURL, err)
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprintf(w, "Health check failed: %s", string(output))
		return
	}

	log.Printf("Health check succeeded for %s", targetURL)
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

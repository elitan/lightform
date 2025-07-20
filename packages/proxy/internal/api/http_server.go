package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/elitan/iop/proxy/internal/cert"
	"github.com/elitan/iop/proxy/internal/health"
	"github.com/elitan/iop/proxy/internal/state"
)

// HTTPServer provides HTTP API for CLI commands
type HTTPServer struct {
	state           *state.State
	certManager     *cert.Manager
	healthChecker   *health.Checker
	server          *http.Server
	httpServerReady <-chan struct{}
}

// NewHTTPServer creates a new HTTP API server
func NewHTTPServer(st *state.State, cm *cert.Manager, hc *health.Checker) *HTTPServer {
	return &HTTPServer{
		state:         st,
		certManager:   cm,
		healthChecker: hc,
	}
}

// NewHTTPServerWithReadiness creates a new HTTP API server with HTTP server readiness signal
func NewHTTPServerWithReadiness(st *state.State, cm *cert.Manager, hc *health.Checker, httpServerReady <-chan struct{}) *HTTPServer {
	return &HTTPServer{
		state:           st,
		certManager:     cm,
		healthChecker:   hc,
		httpServerReady: httpServerReady,
	}
}

// HTTP request/response structures
type HTTPDeployRequest struct {
	Host       string `json:"host"`
	Target     string `json:"target"`
	Project    string `json:"project"`
	App        string `json:"app"`
	HealthPath string `json:"health_path"`
	SSL        bool   `json:"ssl"`
}

type HTTPResponse struct {
	Success bool        `json:"success"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

type HealthUpdateRequest struct {
	Healthy bool `json:"healthy"`
}

type StagingRequest struct {
	Enabled bool `json:"enabled"`
}

// Start starts the HTTP API server on localhost:8080
func (s *HTTPServer) Start() error {
	mux := http.NewServeMux()

	// API routes
	mux.HandleFunc("/api/deploy", s.handleDeploy)
	mux.HandleFunc("/api/hosts/", s.handleHosts)          // For DELETE /api/hosts/:host and PUT /api/hosts/:host/health
	mux.HandleFunc("/api/hosts", s.handleHostsList)       // For GET /api/hosts
	mux.HandleFunc("/api/cert/renew/", s.handleCertRenew) // For POST /api/cert/renew/:host
	mux.HandleFunc("/api/staging", s.handleStaging)       // For PUT /api/staging
	mux.HandleFunc("/api/status", s.handleStatus)         // For GET /api/status

	s.server = &http.Server{
		Addr:    "localhost:8080",
		Handler: mux,
	}

	log.Printf("[HTTP-API] Starting HTTP API server on localhost:8080")

	go func() {
		if err := s.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[HTTP-API] HTTP API server error: %v", err)
		}
	}()

	return nil
}

// Stop gracefully stops the HTTP server
func (s *HTTPServer) Stop() error {
	if s.server != nil {
		return s.server.Close()
	}
	return nil
}

// handleDeploy handles POST /api/deploy
func (s *HTTPServer) handleDeploy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req HTTPDeployRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeErrorResponse(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	log.Printf("[HTTP-API] Deploy request for host %s with SSL=%v", req.Host, req.SSL)

	// Validate required fields
	if req.Host == "" || req.Target == "" || req.Project == "" {
		s.writeErrorResponse(w, "Missing required fields: host, target, project", http.StatusBadRequest)
		return
	}

	// Set default health path if not provided
	if req.HealthPath == "" {
		req.HealthPath = "/up"
	}

	// Update state directly in memory
	if err := s.state.DeployHost(req.Host, req.Target, req.Project, req.App, req.HealthPath, req.SSL); err != nil {
		s.writeErrorResponse(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Trigger immediate health check
	go s.healthChecker.CheckHost(req.Host)

	// Attempt immediate certificate acquisition if SSL enabled
	if req.SSL {
		log.Printf("[HTTP-API] SSL enabled - starting immediate certificate acquisition for %s", req.Host)
		go func() {
			// Wait for HTTP server to be ready to handle ACME challenges if we have a readiness channel
			if s.httpServerReady != nil {
				log.Printf("[HTTP-API] Waiting for HTTP server readiness before certificate acquisition for %s", req.Host)

				// Wait for HTTP server readiness with timeout
				select {
				case <-s.httpServerReady:
					log.Printf("[HTTP-API] HTTP server is ready, starting certificate acquisition for %s", req.Host)
				case <-time.After(10 * time.Second):
					log.Printf("[HTTP-API] HTTP server readiness timeout after 10 seconds for %s, proceeding with certificate acquisition", req.Host)
				}
			} else {
				// Fallback to sleep if no readiness channel (backward compatibility)
				log.Printf("[HTTP-API] No readiness channel, using fallback delay before certificate acquisition for %s", req.Host)
				time.Sleep(2 * time.Second)
			}

			if err := s.certManager.AcquireCertificate(req.Host); err != nil {
				log.Printf("[HTTP-API] Certificate acquisition failed for %s: %v", req.Host, err)
				log.Printf("[HTTP-API] Certificate will be retried by background worker")
			} else {
				log.Printf("[HTTP-API] Certificate acquisition completed successfully for %s", req.Host)
			}
		}()
	}

	s.writeSuccessResponse(w, fmt.Sprintf("Deployed host %s", req.Host), nil)
}

// handleHosts handles routes that start with /api/hosts/
func (s *HTTPServer) handleHosts(w http.ResponseWriter, r *http.Request) {
	// Parse the URL path to extract the hostname
	path := strings.TrimPrefix(r.URL.Path, "/api/hosts/")
	parts := strings.Split(path, "/")

	if len(parts) < 1 || parts[0] == "" {
		http.Error(w, "Host not specified", http.StatusBadRequest)
		return
	}

	hostname := parts[0]

	switch r.Method {
	case http.MethodDelete:
		if len(parts) == 1 {
			// DELETE /api/hosts/:host
			s.handleRemoveHost(w, hostname)
		} else {
			http.Error(w, "Invalid path", http.StatusNotFound)
		}
	case http.MethodPut:
		if len(parts) == 2 && parts[1] == "health" {
			// PUT /api/hosts/:host/health
			s.handleUpdateHealth(w, hostname, r)
		} else {
			http.Error(w, "Invalid path", http.StatusNotFound)
		}
	case http.MethodPatch:
		if len(parts) == 1 {
			// PATCH /api/hosts/:host - for switching target
			s.handleSwitchTarget(w, hostname, r)
		} else {
			http.Error(w, "Invalid path", http.StatusNotFound)
		}
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleHostsList handles GET /api/hosts
func (s *HTTPServer) handleHostsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	hosts := s.state.GetAllHosts()
	s.writeSuccessResponse(w, "", hosts)
}

// handleRemoveHost handles DELETE /api/hosts/:host
func (s *HTTPServer) handleRemoveHost(w http.ResponseWriter, hostname string) {
	log.Printf("[HTTP-API] Remove request for host %s", hostname)

	if err := s.state.RemoveHost(hostname); err != nil {
		s.writeErrorResponse(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.writeSuccessResponse(w, fmt.Sprintf("Removed host %s", hostname), nil)
}

// handleUpdateHealth handles PUT /api/hosts/:host/health
func (s *HTTPServer) handleUpdateHealth(w http.ResponseWriter, hostname string, r *http.Request) {
	var req HealthUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeErrorResponse(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	log.Printf("[HTTP-API] UpdateHealth request for host %s, healthy=%v", hostname, req.Healthy)

	if err := s.state.UpdateHealthStatus(hostname, req.Healthy); err != nil {
		s.writeErrorResponse(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.writeSuccessResponse(w, fmt.Sprintf("Updated health for %s", hostname), nil)
}

// handleCertRenew handles POST /api/cert/renew/:host
func (s *HTTPServer) handleCertRenew(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract hostname from path
	path := strings.TrimPrefix(r.URL.Path, "/api/cert/renew/")
	hostname := strings.Split(path, "/")[0]

	if hostname == "" {
		http.Error(w, "Host not specified", http.StatusBadRequest)
		return
	}

	log.Printf("[HTTP-API] CertRenew request for host %s", hostname)

	if err := s.certManager.RenewCertificate(hostname); err != nil {
		s.writeErrorResponse(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.writeSuccessResponse(w, fmt.Sprintf("Certificate renewal initiated for %s", hostname), nil)
}

// handleStaging handles PUT /api/staging
func (s *HTTPServer) handleStaging(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req StagingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeErrorResponse(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	log.Printf("[HTTP-API] SetStaging request, enabled=%v", req.Enabled)

	// Update the state with new staging mode
	s.state.SetLetsEncryptStaging(req.Enabled)

	// Update the ACME client to use the new directory URL
	if err := s.certManager.UpdateACMEClient(); err != nil {
		log.Printf("[HTTP-API] Failed to update ACME client: %v", err)
		s.writeErrorResponse(w, fmt.Sprintf("Failed to update ACME client: %v", err), http.StatusInternalServerError)
		return
	}

	mode := "production"
	if req.Enabled {
		mode = "staging"
	}

	s.writeSuccessResponse(w, fmt.Sprintf("Set Let's Encrypt mode to %s", mode), nil)
}

// handleStatus handles GET /api/status
func (s *HTTPServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get host query parameter for specific host cert status
	hostname := r.URL.Query().Get("host")

	hosts := s.state.GetAllHosts()

	if hostname != "" {
		// Return status for specific host
		if host, exists := hosts[hostname]; exists {
			s.writeSuccessResponse(w, "", host.Certificate)
		} else {
			s.writeErrorResponse(w, "Host not found", http.StatusNotFound)
		}
	} else {
		// Return status for all hosts
		certStatuses := make(map[string]interface{})
		for hostName, host := range hosts {
			certStatuses[hostName] = host.Certificate
		}
		s.writeSuccessResponse(w, "", certStatuses)
	}
}

// handleSwitchTarget handles PATCH /api/hosts/:host
func (s *HTTPServer) handleSwitchTarget(w http.ResponseWriter, hostname string, r *http.Request) {
	var req map[string]string
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeErrorResponse(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	target, exists := req["target"]
	if !exists || target == "" {
		s.writeErrorResponse(w, "Missing target field", http.StatusBadRequest)
		return
	}

	log.Printf("[HTTP-API] SwitchTarget request for host %s to target %s", hostname, target)

	if err := s.state.SwitchTarget(hostname, target); err != nil {
		s.writeErrorResponse(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.writeSuccessResponse(w, fmt.Sprintf("Switched %s to target %s", hostname, target), nil)
}

// Helper methods for JSON responses
func (s *HTTPServer) writeSuccessResponse(w http.ResponseWriter, message string, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	response := HTTPResponse{
		Success: true,
		Message: message,
		Data:    data,
	}
	json.NewEncoder(w).Encode(response)
}

func (s *HTTPServer) writeErrorResponse(w http.ResponseWriter, message string, statusCode int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	response := HTTPResponse{
		Success: false,
		Message: message,
	}
	json.NewEncoder(w).Encode(response)
}

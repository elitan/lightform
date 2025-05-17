package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"luma/cloudflare"
	"luma/manager"
)

// DomainHandler handles API requests related to domains.
type DomainHandler struct {
	cloudflareManager *cloudflare.Manager
	stateManager      *manager.StateManager // Changed interface to concrete type
}

// NewDomainHandler creates a new DomainHandler.
func NewDomainHandler(cm *cloudflare.Manager, sm *manager.StateManager) *DomainHandler {
	return &DomainHandler{
		cloudflareManager: cm,
		stateManager:      sm,
	}
}

// GetDomainForProject godoc
// @Summary Get domain information for a project
// @Description Returns domain information for a project by its hostname
// @Tags domains
// @Accept json
// @Produce json
// @Param hostname path string true "Project hostname"
// @Success 200 {object} types.ProjectDomain "Domain information"
// @Failure 404 {object} map[string]string "error: Project or domain not found"
// @Failure 500 {object} map[string]string "error: Internal server error"
// @Router /domains/{hostname} [get]
func (h *DomainHandler) GetDomainForProject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Only GET method is allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract hostname from URL path
	hostname := r.URL.Path[len("/domains/"):]
	if hostname == "" {
		http.Error(w, "Hostname is required", http.StatusBadRequest)
		return
	}

	// Check if project exists
	_, exists := h.stateManager.GetProjectByHostname(hostname)
	if !exists {
		http.Error(w, fmt.Sprintf("Project for hostname '%s' not found", hostname), http.StatusNotFound)
		return
	}

	// Get domain info
	domain, exists := h.cloudflareManager.GetProjectDomain(hostname)
	if !exists {
		http.Error(w, fmt.Sprintf("Domain for project with hostname '%s' not found", hostname), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(domain); err != nil {
		log.Printf("Failed to encode domain response: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
}

// ListAllDomains godoc
// @Summary List all domains
// @Description Returns a list of all domains managed by the application
// @Tags domains
// @Accept json
// @Produce json
// @Success 200 {array} types.ProjectDomain "List of domains"
// @Failure 500 {object} map[string]string "error: Internal server error"
// @Router /domains [get]
func (h *DomainHandler) ListAllDomains(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Only GET method is allowed", http.StatusMethodNotAllowed)
		return
	}

	domains := h.cloudflareManager.GetAllDomains()

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(domains); err != nil {
		log.Printf("Failed to encode domains response: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
}

// CreateDomainForProject godoc
// @Summary Create a domain for an existing project
// @Description Creates a new domain for an existing project
// @Tags domains
// @Accept json
// @Produce json
// @Param hostname path string true "Project hostname"
// @Success 201 {object} types.ProjectDomain "The created domain"
// @Failure 400 {object} map[string]string "error: Invalid request"
// @Failure 404 {object} map[string]string "error: Project not found"
// @Failure 500 {object} map[string]string "error: Failed to create domain"
// @Router /domains/{hostname} [post]
func (h *DomainHandler) CreateDomainForProject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract hostname from URL path
	hostname := r.URL.Path[len("/domains/"):]
	if hostname == "" {
		http.Error(w, "Hostname is required", http.StatusBadRequest)
		return
	}

	// Check if project exists
	projectState, exists := h.stateManager.GetProjectByHostname(hostname)
	if !exists {
		http.Error(w, fmt.Sprintf("Project for hostname '%s' not found", hostname), http.StatusNotFound)
		return
	}

	// Check if domain already exists
	if _, exists := h.cloudflareManager.GetProjectDomain(hostname); exists {
		http.Error(w, fmt.Sprintf("Domain for project with hostname '%s' already exists", hostname), http.StatusBadRequest)
		return
	}

	// Create domain
	domain, err := h.cloudflareManager.RegisterProjectDomain(context.Background(), projectState.ProjectConfig)
	if err != nil {
		log.Printf("Failed to create domain for project '%s': %v", projectState.ProjectConfig.Name, err)
		http.Error(w, fmt.Sprintf("Failed to create domain: %v", err), http.StatusInternalServerError)
		return
	}

	if domain == nil {
		// Domain creation was skipped (Cloudflare integration disabled)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(map[string]string{"message": "Domain creation skipped (Cloudflare integration disabled)"}); err != nil {
			log.Printf("Failed to encode domain creation skipped response: %v", err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(domain); err != nil {
		log.Printf("Failed to encode created domain response: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
}

// DeleteDomainForProject godoc
// @Summary Delete domain for a project
// @Description Deletes the domain for a project
// @Tags domains
// @Accept json
// @Produce json
// @Param hostname path string true "Project hostname"
// @Success 200 {object} map[string]string "message: Domain deleted successfully"
// @Failure 404 {object} map[string]string "error: Project or domain not found"
// @Failure 500 {object} map[string]string "error: Failed to delete domain"
// @Router /domains/{hostname} [delete]
func (h *DomainHandler) DeleteDomainForProject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Only DELETE method is allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract hostname from URL path
	hostname := r.URL.Path[len("/domains/"):]
	if hostname == "" {
		http.Error(w, "Hostname is required", http.StatusBadRequest)
		return
	}

	// Check if domain exists
	_, exists := h.cloudflareManager.GetProjectDomain(hostname)
	if !exists {
		http.Error(w, fmt.Sprintf("Domain for project with hostname '%s' not found", hostname), http.StatusNotFound)
		return
	}

	// Delete domain
	if err := h.cloudflareManager.DeleteProjectDomain(context.Background(), hostname); err != nil {
		log.Printf("Failed to delete domain for project with hostname '%s': %v", hostname, err)
		http.Error(w, fmt.Sprintf("Failed to delete domain: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{"message": "Domain deleted successfully"}); err != nil {
		log.Printf("Failed to encode domain deletion response: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
}

// RegisterDomainHandlers registers the domain handlers with the given mux
func (h *DomainHandler) RegisterDomainHandlers(mux *http.ServeMux) {
	// GET /domains - List all domains
	// GET /domains/{hostname} - Get domain for project
	// POST /domains/{hostname} - Create domain for project
	// DELETE /domains/{hostname} - Delete domain for project
	mux.HandleFunc("/domains", h.handleDomainRoot)
	mux.HandleFunc("/domains/", h.handleDomainPaths)
}

// handleDomainRoot handles requests to /domains
func (h *DomainHandler) handleDomainRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/domains" {
		http.NotFound(w, r)
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.ListAllDomains(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleDomainPaths handles requests to /domains/{hostname}
func (h *DomainHandler) handleDomainPaths(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/domains/" {
		http.Error(w, "Hostname is required", http.StatusBadRequest)
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.GetDomainForProject(w, r)
	case http.MethodPost:
		h.CreateDomainForProject(w, r)
	case http.MethodDelete:
		h.DeleteDomainForProject(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}
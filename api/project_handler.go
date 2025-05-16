package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"luma/cloudflare"
	"luma/manager"
	"luma/types"
)

// ProjectHandler handles API requests related to projects.
type ProjectHandler struct {
	stateManager     *manager.StateManager
	cloudflareManager *cloudflare.Manager
}

// NewProjectHandler creates a new ProjectHandler.
func NewProjectHandler(sm *manager.StateManager) *ProjectHandler {
	return &ProjectHandler{stateManager: sm}
}

// WithCloudflareManager adds Cloudflare integration to the ProjectHandler.
func (h *ProjectHandler) WithCloudflareManager(cm *cloudflare.Manager) *ProjectHandler {
	h.cloudflareManager = cm
	return h
}

// RegisterProjectResponse is the response format for project registration
type RegisterProjectResponse struct {
	Message string                 `json:"message"`
	Project types.Project          `json:"project"`
	Domain  *types.ProjectDomain   `json:"domain,omitempty"`
}

// RegisterProject godoc
// @Summary Register a new project
// @Description Registers a new project with its Docker image, environment variables, container port, and hostname.
// @Tags projects
// @Accept json
// @Produce json
// @Param project body types.Project true "Project Registration Details"
// @Success 201 {object} RegisterProjectResponse "Project registered successfully with optional domain information"
// @Failure 400 {object} map[string]string "error: Invalid request payload or project details"
// @Failure 500 {object} map[string]string "error: Failed to register project"
// @Router /projects [post]
func (h *ProjectHandler) RegisterProject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is allowed", http.StatusMethodNotAllowed)
		return
	}

	var project types.Project
	if err := json.NewDecoder(r.Body).Decode(&project); err != nil {
		http.Error(w, fmt.Sprintf("Invalid request payload: %v", err), http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	// Basic validation
	if project.Name == "" || project.DockerImage == "" || project.Hostname == "" || project.ContainerPort <= 0 {
		http.Error(w, "Missing required project fields (Name, DockerImage, Hostname, ContainerPort must be valid)", http.StatusBadRequest)
		return
	}

	// Log before attempting to register
	log.Printf("Attempting to register project: Name=%s, Image=%s, Hostname=%s, Port=%d",
		project.Name, project.DockerImage, project.Hostname, project.ContainerPort)

	if err := h.stateManager.RegisterProject(project); err != nil {
		// This basic state manager currently doesn't return errors other than potential future validation errors.
		log.Printf("Failed to register project %s: %v", project.Name, err)
		http.Error(w, fmt.Sprintf("Failed to register project: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("Successfully registered project: Name=%s, Hostname=%s", project.Name, project.Hostname)

	// Prepare response
	response := RegisterProjectResponse{
		Message: "Project registered successfully: " + project.Name,
		Project: project,
	}

	// If Cloudflare integration is enabled, create a domain for the project
	if h.cloudflareManager != nil && h.cloudflareManager.IsEnabled() {
		log.Printf("Attempting to create domain for project: %s", project.Name)
		domain, err := h.cloudflareManager.RegisterProjectDomain(context.Background(), project)
		if err != nil {
			log.Printf("Warning: Failed to create domain for project %s: %v", project.Name, err)
			// Continue with project registration, just log the domain creation failure
		} else if domain != nil {
			log.Printf("Successfully created domain for project %s: %s", project.Name, domain.Domain)
			response.Domain = domain
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Failed to encode project registration response: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
}
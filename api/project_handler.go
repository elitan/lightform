package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"luma/manager"
	"luma/types"
)

// ProjectHandler handles API requests related to projects.
type ProjectHandler struct {
	stateManager *manager.StateManager
}

// NewProjectHandler creates a new ProjectHandler.
func NewProjectHandler(sm *manager.StateManager) *ProjectHandler {
	return &ProjectHandler{stateManager: sm}
}

// RegisterProject godoc
// @Summary Register a new project
// @Description Registers a new project with its Docker image, environment variables, container port, and hostname.
// @Tags projects
// @Accept json
// @Produce json
// @Param project body types.Project true "Project Registration Details"
// @Success 201 {object} map[string]string "message: Project registered successfully"
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

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"message": "Project registered successfully: " + project.Name})
}

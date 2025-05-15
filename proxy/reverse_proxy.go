package proxy

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"luma/manager"
)

// ReverseProxyHandler handles incoming HTTP requests, routes them to the correct project,
// starts containers on demand, and forwards the request.
type ReverseProxyHandler struct {
	stateManager     *manager.StateManager
	containerManager *manager.ContainerManager
}

// NewReverseProxyHandler creates a new ReverseProxyHandler.
func NewReverseProxyHandler(sm *manager.StateManager, cm *manager.ContainerManager) *ReverseProxyHandler {
	return &ReverseProxyHandler{
		stateManager:     sm,
		containerManager: cm,
	}
}

func (h *ReverseProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Extract hostname from request
	hostname := r.Host
	// For local testing, r.Host might include the port. We typically want just the host part.
	if strings.Contains(hostname, ":") {
		hostname = strings.Split(hostname, ":")[0]
	}

	log.Printf("Incoming request: Host=%s, Path=%s, Method=%s, RemoteAddr=%s", hostname, r.URL.Path, r.Method, r.RemoteAddr)

	// Lookup project in StateManager
	projectState, exists := h.stateManager.GetProjectByHostname(hostname)
	if !exists {
		http.Error(w, fmt.Sprintf("Project for hostname '%s' not found", hostname), http.StatusNotFound)
		return
	}

	// Check if container is running, start if not
	if !projectState.IsRunning || projectState.ContainerID == "" {
		log.Printf("Container for project '%s' (hostname: %s) not running or no container ID. Attempting to start...", projectState.ProjectConfig.Name, hostname)
		// TODO: Use a request-scoped context, or a background context with timeout for container start
		containerID, hostPort, err := h.containerManager.StartContainer(context.Background(), projectState.ProjectConfig)
		if err != nil {
			log.Printf("Error starting container for project '%s': %v", projectState.ProjectConfig.Name, err)
			http.Error(w, fmt.Sprintf("Failed to start container for project %s: %v", projectState.ProjectConfig.Name, err), http.StatusInternalServerError)
			// Optionally, mark project as failed or implement backoff for retries
			return
		}
		h.stateManager.UpdateContainerStatus(hostname, containerID, hostPort, true)
		projectState, _ = h.stateManager.GetProjectByHostname(hostname) // Re-fetch to get updated HostPort
		log.Printf("Successfully started container for project '%s'. ID: %s, HostPort: %d", projectState.ProjectConfig.Name, containerID, hostPort)
	} else {
		log.Printf("Container for project '%s' (hostname: %s) is already running. ID: %s, HostPort: %d. Forwarding request...", projectState.ProjectConfig.Name, hostname, projectState.ContainerID, projectState.HostPort)
	}

	// Update last request time
	h.stateManager.UpdateLastRequestTime(hostname)

	// Create reverse proxy
	targetURL, err := url.Parse(fmt.Sprintf("http://localhost:%d", projectState.HostPort))
	if err != nil {
		http.Error(w, fmt.Sprintf("Internal server error: failed to parse target URL for project %s: %v", projectState.ProjectConfig.Name, err), http.StatusInternalServerError)
		log.Printf("Error parsing target URL for project %s: http://localhost:%d - %v", projectState.ProjectConfig.Name, projectState.HostPort, err)
		return
	}

	reverseProxy := httputil.NewSingleHostReverseProxy(targetURL)

	// Modify request to have correct host for the target container if needed (usually not necessary for localhost proxying)
	// r.Host = targetURL.Host // This can be important if the application inside the container expects a specific Host header.
	// However, for simple cases, it might not be needed. Let's keep it commented for now.

	log.Printf("Forwarding request for project '%s' (hostname: %s) to target %s (Container ID: %s)", projectState.ProjectConfig.Name, hostname, targetURL, projectState.ContainerID)
	reverseProxy.ServeHTTP(w, r)
}

// InactivityMonitor periodically checks for inactive containers and stops them.
func (h *ReverseProxyHandler) InactivityMonitor(ctx context.Context, checkInterval time.Duration, inactivityTimeout time.Duration) {
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	log.Println("Inactivity monitor started.")

	for {
		select {
		case <-ctx.Done():
			log.Println("Inactivity monitor stopping.")
			return
		case <-ticker.C:
			log.Println("Inactivity monitor: Running check for idle containers...")
			projects := h.stateManager.GetAllProjects()
			foundIdle := false
			for _, pState := range projects {
				if pState.IsRunning && time.Since(pState.LastRequest) > inactivityTimeout {
					foundIdle = true
					log.Printf("Inactivity monitor: Project '%s' (hostname: %s, container: %s) inactive for over %v. Attempting to stop...",
						pState.ProjectConfig.Name, pState.ProjectConfig.Hostname, pState.ContainerID, inactivityTimeout)

					err := h.containerManager.StopContainer(ctx, pState.ContainerID)
					if err != nil {
						log.Printf("Inactivity monitor: Error stopping container %s for project '%s': %v", pState.ContainerID, pState.ProjectConfig.Name, err)
						// Decide if we need to do more here, e.g. retry or mark as problematic
					} else {
						h.stateManager.UpdateContainerStatus(pState.ProjectConfig.Hostname, "", 0, false)
						log.Printf("Inactivity monitor: Successfully stopped container %s for project '%s'.", pState.ContainerID, pState.ProjectConfig.Name)
					}
				}
			}
			if !foundIdle {
				log.Println("Inactivity monitor: No idle containers found.")
			}
		}
	}
}

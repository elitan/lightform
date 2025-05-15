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
	"luma/types" // Added for passing project config
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

	// log.Printf("Incoming request: Host=%s, Path=%s, Method=%s, RemoteAddr=%s", hostname, r.URL.Path, r.Method, r.RemoteAddr)

	// Lookup project in StateManager
	projectState, exists := h.stateManager.GetProjectByHostname(hostname)
	if !exists {
		http.Error(w, fmt.Sprintf("Project for hostname '%s' not found", hostname), http.StatusNotFound)
		return
	}

	// Check if container is running, start if not
	if !projectState.IsRunning || projectState.ContainerID == "" {
		log.Printf("ReverseProxy: Project '%s' (hostname: %s) not running or no container ID. Entering start logic.", projectState.ProjectConfig.Name, hostname)

		waitChan, isInitiator := h.stateManager.EnsureProjectStarting(hostname)

		if isInitiator {
			log.Printf("ReverseProxy: This request is the initiator for starting project '%s' (hostname: %s).", projectState.ProjectConfig.Name, hostname)
			// Make a copy of the project config to pass to the goroutine to avoid data races
			// if projectState or its inner ProjectConfig gets modified elsewhere.
			configCopy := projectState.ProjectConfig
			go func(config types.Project, projHostname string) {
				defer h.stateManager.SignalStartAttemptComplete(projHostname)

				log.Printf("ReverseProxy (initiator goroutine): Attempting to start container for project '%s' (hostname: %s)...", config.Name, projHostname)
				// Use a background context with a timeout for the container start operation itself.
				// This timeout should be reasonably generous.
				startCtx, cancelStart := context.WithTimeout(context.Background(), 60*time.Second) // e.g., 60 seconds for container start
				defer cancelStart()

				containerID, hostPort, err := h.containerManager.StartContainer(startCtx, config)
				if err != nil {
					log.Printf("ReverseProxy (initiator goroutine): Error starting container for project '%s': %v", config.Name, err)
					// Update status to reflect failure. This ensures waiting requests see the failure.
					h.stateManager.UpdateContainerStatus(projHostname, "", 0, false)
					return
				}
				h.stateManager.UpdateContainerStatus(projHostname, containerID, hostPort, true)
				log.Printf("ReverseProxy (initiator goroutine): Successfully started container for project '%s'. ID: %s, HostPort: %d", config.Name, containerID, hostPort)
			}(configCopy, hostname)
		} else {
			log.Printf("ReverseProxy: Another request is already initiating start for project '%s' (hostname: %s). Waiting...", projectState.ProjectConfig.Name, hostname)
		}

		// All requests (initiator or followers) wait here.
		log.Printf("ReverseProxy: Waiting for container start completion for project '%s' (hostname: %s)...", projectState.ProjectConfig.Name, hostname)
		select {
		case <-waitChan:
			log.Printf("ReverseProxy: Container start attempt for project '%s' (hostname: %s) completed. Re-fetching state.", projectState.ProjectConfig.Name, hostname)
			// Re-fetch project state as it's updated by the initiator's goroutine
			var currentExists bool
			projectState, currentExists = h.stateManager.GetProjectByHostname(hostname)
			if !currentExists {
				log.Printf("ReverseProxy: Error - Project '%s' disappeared after start attempt.", hostname)
				http.Error(w, fmt.Sprintf("Project for hostname '%s' not found after start attempt", hostname), http.StatusInternalServerError)
				return
			}
			if !projectState.IsRunning || projectState.ContainerID == "" {
				log.Printf("ReverseProxy: Container for project '%s' (hostname: %s) failed to start or state not updated correctly.", projectState.ProjectConfig.Name, hostname)
				http.Error(w, fmt.Sprintf("Failed to start container for project %s after waiting", projectState.ProjectConfig.Name), http.StatusInternalServerError)
				return
			}
			log.Printf("ReverseProxy: Container for project '%s' (hostname: %s) is now running. ID: %s, HostPort: %d. Proceeding.", projectState.ProjectConfig.Name, hostname, projectState.ContainerID, projectState.HostPort)

		case <-r.Context().Done(): // Client cancelled the request
			log.Printf("ReverseProxy: Request for '%s' cancelled by client while waiting for container start.", hostname)
			http.Error(w, "Request cancelled or timed out by client while waiting for container to start", http.StatusServiceUnavailable)
			return
		case <-time.After(65 * time.Second): // Server-side timeout for waiting, slightly > initiator's start timeout
			log.Printf("ReverseProxy: Server-side timeout waiting for container start for project '%s' (hostname: %s). Re-checking state.", projectState.ProjectConfig.Name, hostname)
			// Final check, in case it became ready just as timeout hit
			finalState, finalExists := h.stateManager.GetProjectByHostname(hostname)
			if finalExists && finalState.IsRunning && finalState.ContainerID != "" {
				projectState = finalState // Update to proceed
				log.Printf("ReverseProxy: Container for '%s' became ready just at/after timeout. Proceeding.", hostname)
			} else {
				http.Error(w, fmt.Sprintf("Server timed out waiting for container for project %s to start", projectState.ProjectConfig.Name), http.StatusGatewayTimeout)
				return
			}
		}
	} else {
		// log.Printf("Container for project '%s' (hostname: %s) is already running. ID: %s, HostPort: %d. Forwarding request...", projectState.ProjectConfig.Name, hostname, projectState.ContainerID, projectState.HostPort)
	}

	// Update last request time (do this for both newly started and already running containers)
	h.stateManager.UpdateLastRequestTime(hostname)

	// Create reverse proxy
	targetURL, err := url.Parse(fmt.Sprintf("http://localhost:%d", projectState.HostPort))
	if err != nil {
		http.Error(w, fmt.Sprintf("Internal server error: failed to parse target URL for project %s: %v", projectState.ProjectConfig.Name, err), http.StatusInternalServerError)
		log.Printf("Error parsing target URL for project %s: http://localhost:%d - %v", projectState.ProjectConfig.Name, projectState.HostPort, err)
		return
	}

	reverseProxy := httputil.NewSingleHostReverseProxy(targetURL)

	// log.Printf("Forwarding request for project '%s' (hostname: %s) to target %s (Container ID: %s)", projectState.ProjectConfig.Name, hostname, targetURL, projectState.ContainerID)
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
				if pState.IsRunning {
					timeSinceLastRequest := time.Since(pState.LastRequest)
					if timeSinceLastRequest > inactivityTimeout {
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
					} else {
						// Container is running and not yet idle
						// remainingTime := inactivityTimeout - timeSinceLastRequest
						// log.Printf("Inactivity monitor: Project '%s' (hostname: %s, container: %s) is active. Time until idle check: %.0f seconds.",
						// 	pState.ProjectConfig.Name, pState.ProjectConfig.Hostname, pState.ContainerID, remainingTime.Seconds())
					}
				}
			}
			if !foundIdle {
				log.Println("Inactivity monitor: No idle containers found.")
			}
		}
	}
}

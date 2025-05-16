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

	// Get current container state
	containerState := h.stateManager.GetContainerState(hostname)

	// Check if container is not running or in a state that requires action
	if containerState != manager.StateRunning {
		log.Printf("ReverseProxy: Project '%s' (hostname: %s) container state: %s. Checking if action needed.",
			projectState.ProjectConfig.Name, hostname, containerState)

		// If container is stopping, we need to wait until it's fully stopped before trying to start
		if containerState == manager.StateStopping {
			log.Printf("ReverseProxy: Container for project '%s' (hostname: %s) is currently stopping. Need to wait before starting.",
				projectState.ProjectConfig.Name, hostname)

			// Wait a reasonable time for it to stop
			waitTime := 5 * time.Second
			select {
			case <-time.After(waitTime):
				// Recheck state after waiting
				containerState = h.stateManager.GetContainerState(hostname)
				if containerState == manager.StateStopping {
					// Still stopping, return error to client
					http.Error(w, fmt.Sprintf("Container for project %s is currently stopping, please try again shortly",
						projectState.ProjectConfig.Name), http.StatusServiceUnavailable)
					return
				}
			case <-r.Context().Done():
				// Client cancelled while waiting
				log.Printf("ReverseProxy: Request for '%s' cancelled while waiting for container to stop.", hostname)
				http.Error(w, "Request cancelled while waiting for container to complete stopping", http.StatusServiceUnavailable)
				return
			}
		}

		// Start container if it's idle, stopped, or just finished stopping
		if containerState == manager.StateIdle || containerState == manager.StateStopped {
			log.Printf("ReverseProxy: Project '%s' (hostname: %s) container state: %s. Will attempt to start.",
				projectState.ProjectConfig.Name, hostname, containerState)

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

				// Check the container state after waiting
				containerState = h.stateManager.GetContainerState(hostname)
				if containerState != manager.StateRunning {
					log.Printf("ReverseProxy: Container for project '%s' (hostname: %s) failed to start. Current state: %s",
						projectState.ProjectConfig.Name, hostname, containerState)
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
				containerState = h.stateManager.GetContainerState(hostname)
				if containerState == manager.StateRunning {
					// Refresh project state to get latest container details
					projectState, _ = h.stateManager.GetProjectByHostname(hostname)
					log.Printf("ReverseProxy: Container for '%s' became ready just at/after timeout. Proceeding.", hostname)
				} else {
					http.Error(w, fmt.Sprintf("Server timed out waiting for container for project %s to start", projectState.ProjectConfig.Name), http.StatusGatewayTimeout)
					return
				}
			}
		}
	}
	// Container is already running, proceeding to forward the request

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
				containerState := h.stateManager.GetContainerState(pState.ProjectConfig.Hostname)

				// Only process if the container is currently running
				if containerState == manager.StateRunning {
					timeSinceLastRequest := time.Since(pState.LastRequest)
					if timeSinceLastRequest > inactivityTimeout {
						foundIdle = true
						log.Printf("Inactivity monitor: Project '%s' (hostname: %s, container: %s) inactive for over %v. Attempting to stop...",
							pState.ProjectConfig.Name, pState.ProjectConfig.Hostname, pState.ContainerID, inactivityTimeout)

						// Use the safe stop method
						err := h.containerManager.SafelyStopProjectContainer(ctx, pState.ProjectConfig.Hostname)
						if err != nil {
							log.Printf("Inactivity monitor: Error safely stopping container for project '%s': %v",
								pState.ProjectConfig.Name, err)
							// Here we don't need to update state as the SafelyStopProjectContainer does that
						} else {
							log.Printf("Inactivity monitor: Successfully stopped container for project '%s'.",
								pState.ProjectConfig.Name)
						}
					} else {
						// Container is running and not yet idle
						remainingTime := inactivityTimeout - timeSinceLastRequest
						log.Printf("Inactivity monitor: Project '%s' (hostname: %s, container: %.5s) is active. Time until idle check: %.0f seconds.",
							pState.ProjectConfig.Name, pState.ProjectConfig.Hostname, pState.ContainerID, remainingTime.Seconds())
					}
				}
			}

			if !foundIdle {
				log.Println("Inactivity monitor: No idle containers found.")
			}
		}
	}
}

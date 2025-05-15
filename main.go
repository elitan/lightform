package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"luma/api"
	"luma/manager"
	"luma/proxy"
)

const (
	serverPort        = ":8080"
	inactivityTimeout = 20 * time.Second
	checkInterval     = 3 * time.Second // How often to check for inactive containers
)

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Initialize managers
	stateManager := manager.NewStateManager()
	containerManager, err := manager.NewContainerManager()
	if err != nil {
		log.Fatalf("Failed to initialize ContainerManager: %v", err)
	}

	// Initialize handlers
	projectAPIHandler := api.NewProjectHandler(stateManager)
	reverseProxyHandler := proxy.NewReverseProxyHandler(stateManager, containerManager)

	// Start inactivity monitor in a goroutine
	go reverseProxyHandler.InactivityMonitor(ctx, checkInterval, inactivityTimeout)

	// Setup HTTP server
	mux := http.NewServeMux()
	mux.HandleFunc("/projects", projectAPIHandler.RegisterProject) // API endpoint for project registration
	mux.Handle("/", reverseProxyHandler)                           // Main reverse proxy for all other requests

	server := &http.Server{
		Addr:    serverPort,
		Handler: mux,
	}

	log.Printf("Luma server starting on port %s", serverPort)

	// Graceful shutdown
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("ListenAndServe error: %v", err)
		}
	}()

	// Wait for interrupt signal to gracefully shut down the server
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("Shutting down server...")

	// Signal inactivity monitor to stop
	cancel()

	// Shutdown the HTTP server
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	// Stop all running containers managed by this service
	log.Println("Cleaning up running containers...")
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second) // Give cleanup some time
	defer cleanupCancel()

	allProjects := stateManager.GetAllProjects() // Assuming StateManager has a method to get all states
	stoppedCount := 0
	for _, pState := range allProjects {
		if pState.IsRunning && pState.ContainerID != "" {
			log.Printf("Attempting to stop container '%s' for project '%s' as part of shutdown...", pState.ContainerID, pState.ProjectConfig.Name)
			if err := containerManager.StopContainer(cleanupCtx, pState.ContainerID); err != nil {
				log.Printf("Error stopping container '%s' for project '%s' during shutdown: %v", pState.ContainerID, pState.ProjectConfig.Name, err)
			} else {
				log.Printf("Successfully stopped container '%s' for project '%s' during shutdown.", pState.ContainerID, pState.ProjectConfig.Name)
				stoppedCount++
			}
		}
	}
	if stoppedCount > 0 {
		log.Printf("Successfully stopped %d container(s) during shutdown.", stoppedCount)
	} else {
		log.Println("No running containers needed to be stopped during shutdown.")
	}

	log.Println("Server exited gracefully")
}

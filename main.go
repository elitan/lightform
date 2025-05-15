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
	inactivityTimeout = 1 * time.Minute
	checkInterval     = 10 * time.Second // How often to check for inactive containers
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

	// TODO: Consider stopping all running containers on shutdown
	// This might involve iterating through stateManager.GetAllProjects()
	// and calling containerManager.StopContainer() for each running one.
	// For v1, keeping it simple: containers might keep running if not timed out.

	log.Println("Server exited gracefully")
}

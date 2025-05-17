package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"luma/api"
	"luma/cloudflare"
	"luma/config"
	"luma/manager"
	"luma/proxy"
)

func main() {
	// Parse command line flags
	configPath := flag.String("config", "", "Path to configuration file")
	flag.Parse()

	// Load configuration
	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	// Log startup information
	log.Printf("Starting Luma with configuration:")
	log.Printf("  Proxy Server Port: %s", cfg.ProxyServerPort)
	log.Printf("  API Server Port: %s", cfg.APIServerPort)
	log.Printf("  Inactivity Timeout: %d seconds", cfg.InactivityTimeout)
	log.Printf("  Check Interval: %d seconds", cfg.CheckInterval)
	log.Printf("  Server Address: %s", cfg.ServerAddress)
	log.Printf("  Cloudflare Integration: %v", cfg.Cloudflare.Enabled)
	if cfg.Cloudflare.Enabled {
		log.Printf("  Cloudflare Base Domain: %s", cfg.Cloudflare.BaseDomain)
		log.Printf("  Cloudflare Auto Generate Domains: %v", cfg.Cloudflare.AutoGenerate)
	}

	// Create a cancellable context for all operations
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Initialize managers
	stateManager := manager.NewStateManager()
	containerManager, err := manager.NewContainerManager(stateManager)
	if err != nil {
		log.Fatalf("Failed to initialize ContainerManager: %v", err)
	}

	// Initialize Cloudflare client and manager if enabled
	var cfManager *cloudflare.Manager
	if cfg.Cloudflare.Enabled {
		log.Println("Initializing Cloudflare integration...")
		cfClient, err := cloudflare.NewClient(cfg.Cloudflare, cfg.ServerAddress)
		if err != nil {
			log.Fatalf("Failed to initialize Cloudflare client: %v", err)
		}
		cfManager = cloudflare.NewManager(cfClient, cfg.Cloudflare.AutoGenerate)
		log.Println("Cloudflare integration initialized successfully")
	} else {
		log.Println("Cloudflare integration is disabled")
		// Create a disabled manager
		cfManager = cloudflare.NewManager(nil, false)
	}

	// Initialize handlers
	projectAPIHandler := api.NewProjectHandler(stateManager)
	
	// Connect Cloudflare manager to the project handler
	if cfManager != nil {
		projectAPIHandler = projectAPIHandler.WithCloudflareManager(cfManager)
		log.Println("Cloudflare integration added to project handler")
	}
	
	reverseProxyHandler := proxy.NewReverseProxyHandler(stateManager, containerManager)
	domainAPIHandler := api.NewDomainHandler(cfManager, stateManager)

	// Setup inactivity timeout and check interval
	inactivityTimeout := time.Duration(cfg.InactivityTimeout) * time.Second
	checkInterval := time.Duration(cfg.CheckInterval) * time.Second

	// Start inactivity monitor in a goroutine
	go reverseProxyHandler.InactivityMonitor(ctx, checkInterval, inactivityTimeout)

	// Setup API server
	apiMux := http.NewServeMux()
	apiMux.HandleFunc("/projects", projectAPIHandler.RegisterProject) // API endpoint for project registration
	
	// Register domain handlers if Cloudflare integration is available
	if cfManager != nil {
		domainAPIHandler.RegisterDomainHandlers(apiMux)
		log.Println("Domain management API endpoints registered")
	}

	apiServer := &http.Server{
		Addr:    cfg.APIServerPort,
		Handler: apiMux,
	}

	// Setup Proxy server
	proxyMux := http.NewServeMux()
	proxyMux.Handle("/", reverseProxyHandler) // Main reverse proxy for all other requests

	proxyServer := &http.Server{
		Addr:    cfg.ProxyServerPort,
		Handler: proxyMux,
	}

	log.Printf("Luma API server starting on port %s", cfg.APIServerPort)
	log.Printf("Luma Proxy server starting on port %s", cfg.ProxyServerPort)

	// Start API server
	go func() {
		if err := apiServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("API Server ListenAndServe error: %v", err)
		}
	}()

	// Start Proxy server
	go func() {
		if err := proxyServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Proxy Server ListenAndServe error: %v", err)
		}
	}()

	// Wait for interrupt signal to gracefully shut down the servers
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("Shutting down servers...")

	// Signal inactivity monitor to stop
	cancel()

	// Shutdown the HTTP servers
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second) // Increased timeout slightly for two servers
	defer shutdownCancel()

	log.Println("Attempting to shut down API server...")
	if err := apiServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("API Server failed to shutdown gracefully: %v", err)
	} else {
		log.Println("API Server shutdown complete.")
	}

	// Create a new context for the proxy server shutdown, in case the previous one timed out or was affected
	proxyShutdownCtx, proxyShutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer proxyShutdownCancel()

	log.Println("Attempting to shut down Proxy server...")
	if err := proxyServer.Shutdown(proxyShutdownCtx); err != nil {
		log.Printf("Proxy Server failed to shutdown gracefully: %v", err)
	} else {
		log.Println("Proxy Server shutdown complete.")
	}

	// Stop all running containers managed by this service
	log.Println("Cleaning up running containers...")
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second) // Give cleanup some time
	defer cleanupCancel()

	allProjects := stateManager.GetAllProjects()
	stoppedCount := 0
	for _, pState := range allProjects {
		containerState := stateManager.GetContainerState(pState.ProjectConfig.Hostname)

		// Only attempt to stop containers that are in running or starting state
		if containerState == manager.StateRunning || containerState == manager.StateStarting {
			log.Printf("Attempting to safely stop container for project '%s' as part of shutdown...", pState.ProjectConfig.Name)
			if err := containerManager.SafelyStopProjectContainer(cleanupCtx, pState.ProjectConfig.Hostname); err != nil {
				log.Printf("Error stopping container for project '%s' during shutdown: %v", pState.ProjectConfig.Name, err)
			} else {
				log.Printf("Successfully stopped container for project '%s' during shutdown.", pState.ProjectConfig.Name)
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
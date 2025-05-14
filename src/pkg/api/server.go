package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/elitan/luma/src/pkg/container"
	"github.com/elitan/luma/src/pkg/proxy"
	"github.com/elitan/luma/src/pkg/scaling"
	"github.com/gorilla/mux"
)

// Server represents the API server
type Server struct {
	router           *mux.Router
	containerManager *container.Manager
	proxy            *proxy.ReverseProxy
	scaler           *scaling.Scaler
	port             int
}

// NewServer creates a new API server
func NewServer(port int, inactivityTimeout time.Duration, scaleThreshold int64) (*Server, error) {
	// Create container manager
	manager, err := container.NewManager(inactivityTimeout)
	if err != nil {
		return nil, fmt.Errorf("failed to create container manager: %w", err)
	}

	// Create reverse proxy
	proxy := proxy.New(scaleThreshold)

	// Create scaler
	scaler := scaling.New(manager)

	// Create router
	router := mux.NewRouter()

	server := &Server{
		router:           router,
		containerManager: manager,
		proxy:            proxy,
		scaler:           scaler,
		port:             port,
	}

	// Set up routes
	server.routes()

	return server, nil
}

// routes sets up the API routes
func (s *Server) routes() {
	// API endpoints
	api := s.router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/services", s.listServicesHandler).Methods("GET")
	api.HandleFunc("/services", s.registerServiceHandler).Methods("POST")
	api.HandleFunc("/services/{name}", s.getServiceHandler).Methods("GET")

	// Service proxy - catch all other routes and proxy to the appropriate service
	s.router.PathPrefix("/{service}/").HandlerFunc(s.proxyHandler)

	// Add middleware
	s.router.Use(s.loggingMiddleware)
}

// Start starts the HTTP server
func (s *Server) Start() error {
	addr := fmt.Sprintf(":%d", s.port)
	log.Printf("Starting server on %s", addr)
	return http.ListenAndServe(addr, s.router)
}

// registerServiceHandler registers a new service
func (s *Server) registerServiceHandler(w http.ResponseWriter, r *http.Request) {
	var serviceConfig scaling.ServiceConfig
	if err := json.NewDecoder(r.Body).Decode(&serviceConfig); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if serviceConfig.Name == "" || serviceConfig.Image == "" {
		http.Error(w, "Service name and image are required", http.StatusBadRequest)
		return
	}

	// Register with scaler
	s.scaler.RegisterService(serviceConfig)

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "registered", "service": serviceConfig.Name})
}

// listServicesHandler returns a list of registered services
func (s *Server) listServicesHandler(w http.ResponseWriter, r *http.Request) {
	containers := s.containerManager.ListContainers()
	
	// Convert to a simple response format
	type containerResponse struct {
		Name       string    `json:"name"`
		Image      string    `json:"image"`
		Status     string    `json:"status"`
		StartTime  time.Time `json:"startTime"`
		LastActive time.Time `json:"lastActive"`
		TargetURL  string    `json:"targetUrl"`
	}
	
	response := make([]containerResponse, 0, len(containers))
	for _, c := range containers {
		c.mu.RLock()
		response = append(response, containerResponse{
			Name:       c.Name,
			Image:      c.Image,
			Status:     c.Status,
			StartTime:  c.StartTime,
			LastActive: c.LastActive,
			TargetURL:  c.TargetURL,
		})
		c.mu.RUnlock()
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// getServiceHandler returns details for a specific service
func (s *Server) getServiceHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	name := vars["name"]
	
	container, exists := s.containerManager.GetContainer(name)
	if !exists {
		http.Error(w, "Service not found", http.StatusNotFound)
		return
	}
	
	container.mu.RLock()
	response := map[string]interface{}{
		"name":       container.Name,
		"image":      container.Image,
		"status":     container.Status,
		"startTime":  container.StartTime,
		"lastActive": container.LastActive,
		"targetUrl":  container.TargetURL,
	}
	container.mu.RUnlock()
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// proxyHandler proxies requests to the appropriate service
func (s *Server) proxyHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	serviceName := vars["service"]
	
	// Check if the container is running
	container, exists := s.containerManager.GetContainer(serviceName)
	if !exists {
		// Try to start a new container for this service
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		
		var err error
		container, err = s.containerManager.StartContainer(ctx, serviceName, "nextjs-app:latest")
		if err != nil {
			http.Error(w, "Service unavailable", http.StatusServiceUnavailable)
			return
		}
		
		// Add the backend to the proxy
		if err := s.proxy.AddBackend(serviceName, container.TargetURL); err != nil {
			http.Error(w, "Error configuring proxy", http.StatusInternalServerError)
			return
		}
	}
	
	// Update last active time
	s.containerManager.UpdateLastActive(serviceName)
	
	// Check if we need to scale
	if s.proxy.ShouldScale() {
		go func() {
			if err := s.scaler.ScaleUp(serviceName); err != nil {
				log.Printf("Error scaling up service %s: %v", serviceName, err)
			}
		}()
	}
	
	// Proxy the request
	s.proxy.ProxyRequest(serviceName, w, r)
}

// loggingMiddleware logs incoming requests
func (s *Server) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.RequestURI, time.Since(start))
	})
}
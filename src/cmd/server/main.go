package main

import (
	"flag"
	"log"
	"time"

	"github.com/elitan/luma/src/pkg/api"
)

func main() {
	// Parse command-line flags
	port := flag.Int("port", 8080, "HTTP server port")
	inactivityTimeout := flag.Duration("inactivity-timeout", 10*time.Minute, "Container inactivity timeout")
	scaleThreshold := flag.Int64("scale-threshold", 80, "Request count threshold for scaling")
	flag.Parse()

	// Create and start the server
	server, err := api.NewServer(*port, *inactivityTimeout, *scaleThreshold)
	if err != nil {
		log.Fatalf("Failed to create server: %v", err)
	}

	log.Printf("Starting Luma server on port %d", *port)
	log.Printf("Container inactivity timeout: %s", *inactivityTimeout)
	log.Printf("Scale threshold: %d concurrent requests", *scaleThreshold)

	if err := server.Start(); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
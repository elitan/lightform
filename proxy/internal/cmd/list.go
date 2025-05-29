package cmd

import (
	"flag"
	"log"

	"github.com/elitan/luma-proxy/internal/config"
)

// ListCmd represents the list command
type ListCmd struct {
	fs *flag.FlagSet
}

// NewListCmd creates a new list command
func NewListCmd() *ListCmd {
	cmd := &ListCmd{
		fs: flag.NewFlagSet("list", flag.ExitOnError),
	}

	return cmd
}

// Parse parses the command line arguments
func (c *ListCmd) Parse(args []string) error {
	return c.fs.Parse(args)
}

// Execute executes the list command
func (c *ListCmd) Execute() error {
	// Create and load configuration
	cfg := config.New()
	cfg.Load()

	if len(cfg.Services) == 0 {
		log.Printf("No routes configured")
		return nil
	}

	log.Printf("Configured Routes (%d):", len(cfg.Services))
	log.Printf("========================")

	for _, service := range cfg.Services {
		healthStatus := "❌ Unhealthy"
		if service.Healthy {
			healthStatus = "✅ Healthy"
		}

		log.Printf("Host: %s", service.Host)
		log.Printf("  Target: %s", service.Target)
		log.Printf("  Project: %s", service.Project)
		log.Printf("  Health Path: %s", service.HealthPath)
		log.Printf("  Status: %s", healthStatus)
		log.Printf("")
	}

	return nil
}

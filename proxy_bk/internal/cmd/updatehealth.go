package cmd

import (
	"flag"
	"fmt"
	"log"
	"strconv"

	"github.com/elitan/luma-proxy/internal/config"
	"github.com/elitan/luma-proxy/internal/service"
)

// UpdateHealthCmd represents the updatehealth command
type UpdateHealthCmd struct {
	fs      *flag.FlagSet
	host    *string
	healthy *string
}

// NewUpdateHealthCmd creates a new updatehealth command
func NewUpdateHealthCmd() *UpdateHealthCmd {
	cmd := &UpdateHealthCmd{
		fs: flag.NewFlagSet("updatehealth", flag.ExitOnError),
	}

	cmd.host = cmd.fs.String("host", "", "Host to update health status for")
	cmd.healthy = cmd.fs.String("healthy", "", "Health status (true/false)")

	return cmd
}

// Parse parses the command line arguments
func (c *UpdateHealthCmd) Parse(args []string) error {
	return c.fs.Parse(args)
}

// Execute executes the updatehealth command
func (c *UpdateHealthCmd) Execute() error {
	if *c.host == "" {
		return fmt.Errorf("host is required")
	}

	if *c.healthy == "" {
		return fmt.Errorf("healthy status is required")
	}

	healthy, err := strconv.ParseBool(*c.healthy)
	if err != nil {
		return fmt.Errorf("invalid healthy status, must be true or false: %v", err)
	}

	// Create and load configuration
	cfg := config.New()
	cfg.Load()

	// Create service manager
	serviceManager := service.NewManager(cfg)

	// Update service health
	err = serviceManager.UpdateServiceHealth(*c.host, healthy)
	if err != nil {
		log.Printf("Failed to update health for %s: %v", *c.host, err)
		return err
	}

	log.Printf("Health status for %s updated to %v", *c.host, healthy)
	return nil
}

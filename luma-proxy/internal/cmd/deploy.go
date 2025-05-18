package cmd

import (
	"flag"
	"fmt"
	"log"

	"github.com/elitan/luma-proxy/internal/config"
	"github.com/elitan/luma-proxy/internal/service"
)

// DeployCmd represents the deploy command
type DeployCmd struct {
	fs      *flag.FlagSet
	target  *string
	host    *string
	project *string
}

// NewDeployCmd creates a new deploy command
func NewDeployCmd() *DeployCmd {
	cmd := &DeployCmd{
		fs: flag.NewFlagSet("deploy", flag.ExitOnError),
	}

	cmd.target = cmd.fs.String("target", "", "Target service address in the format ip:port")
	cmd.host = cmd.fs.String("host", "", "Hostname that this service will serve traffic for")
	cmd.project = cmd.fs.String("project", "", "Project identifier (Docker network name)")

	return cmd
}

// Parse parses the command line arguments
func (c *DeployCmd) Parse(args []string) error {
	return c.fs.Parse(args)
}

// Execute executes the deploy command
func (c *DeployCmd) Execute() error {
	// Validate required parameters
	if *c.target == "" {
		return fmt.Errorf("missing required --target parameter")
	}
	if *c.host == "" {
		return fmt.Errorf("missing required --host parameter")
	}

	// If project is not specified, use "default"
	projectName := "default"
	if *c.project != "" {
		projectName = *c.project
	}

	// Create and load configuration
	cfg := config.New()
	cfg.Load()

	// Create service manager
	serviceManager := service.NewManager(cfg)

	// Configure the route
	if err := serviceManager.Deploy(*c.host, *c.target, projectName); err != nil {
		return err
	}

	log.Printf("Route for host '%s' successfully configured to target '%s' in project '%s'",
		*c.host, *c.target, projectName)
	return nil
}

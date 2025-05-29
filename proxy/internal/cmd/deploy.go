package cmd

import (
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/elitan/luma-proxy/internal/cert"
	"github.com/elitan/luma-proxy/internal/config"
	"github.com/elitan/luma-proxy/internal/service"
)

// DeployCmd represents the deploy command
type DeployCmd struct {
	fs         *flag.FlagSet
	target     *string
	host       *string
	project    *string
	certEmail  *string
	healthPath *string
}

// NewDeployCmd creates a new deploy command
func NewDeployCmd() *DeployCmd {
	cmd := &DeployCmd{
		fs: flag.NewFlagSet("deploy", flag.ExitOnError),
	}

	cmd.target = cmd.fs.String("target", "", "Target service address in the format ip:port")
	cmd.host = cmd.fs.String("host", "", "Hostname that this service will serve traffic for")
	cmd.project = cmd.fs.String("project", "", "Project identifier (Docker network name)")
	cmd.certEmail = cmd.fs.String("cert-email", "", "Email address for Let's Encrypt registration")
	cmd.healthPath = cmd.fs.String("health-path", "/up", "Health check endpoint path (default: /up)")

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

	// Use provided cert email or fall back to config
	certEmail := *c.certEmail
	if certEmail == "" {
		certEmail = cfg.Certs.Email
	}

	// Create service manager
	serviceManager := service.NewManager(cfg)

	// Configure the route (automatically uses blue-green for network alias targets)
	if err := serviceManager.DeployWithHealthPath(*c.host, *c.target, projectName, *c.healthPath); err != nil {
		return err
	}

	log.Printf("Route for host '%s' successfully configured to target '%s' in project '%s' with health path '%s'",
		*c.host, *c.target, projectName, *c.healthPath)

	// Immediately add domain to certificate manager for fast SSL provisioning
	log.Printf("Adding domain to certificate manager for immediate SSL provisioning...")
	if err := c.addDomainToCertificateManager(*c.host, certEmail); err != nil {
		log.Printf("Warning: Failed to add domain to certificate manager: %v", err)
		// Fall back to retry queue system
		log.Printf("Falling back to retry queue system...")
	} else {
		log.Printf("✅ Domain %s added to certificate manager - SSL certificates will provision immediately", *c.host)
	}

	// Add to retry queue for background certificate processing as backup
	// Let autocert handle certificate provisioning naturally via HTTP-01 challenges
	log.Printf("Scheduling SSL certificate provisioning for %s...", *c.host)
	if err := c.addToRetryQueue(*c.host, certEmail); err != nil {
		log.Printf("Warning: Failed to add %s to retry queue: %v", *c.host, err)
	} else {
		log.Printf("📋 Added %s to background certificate retry queue", *c.host)
		log.Printf("✅ SSL certificate will be provisioned automatically via background service")
	}

	log.Printf("Route deployed successfully")
	return nil
}

// addToRetryQueue adds a domain to the background certificate retry queue
func (c *DeployCmd) addToRetryQueue(hostname, email string) error {
	// Create a global retry queue (in a real implementation, this would be a singleton)
	queue := cert.NewRetryQueue()

	if err := queue.Add(hostname, email); err != nil {
		return fmt.Errorf("failed to add %s to retry queue: %w", hostname, err)
	}

	log.Printf("Added %s to certificate retry queue (email: %s)", hostname, email)
	return nil
}

// addDomainToCertificateManager adds a domain to the certificate manager
func (c *DeployCmd) addDomainToCertificateManager(hostname, email string) error {
	// Create a trigger file that signals the proxy to reload certificate domains
	// This provides immediate certificate domain addition without waiting for requests
	triggerFile := "/tmp/luma-proxy-cert-reload-trigger"

	// Write the current timestamp to the trigger file
	// The proxy will monitor this file and reload domains when it changes
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	if err := os.WriteFile(triggerFile, []byte(timestamp), 0644); err != nil {
		return fmt.Errorf("failed to create certificate reload trigger: %w", err)
	}

	log.Printf("Created certificate reload trigger for immediate SSL provisioning")
	return nil
}

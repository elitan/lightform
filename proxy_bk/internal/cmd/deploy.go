package cmd

import (
	"flag"
	"fmt"
	"log"
	"os"
	"time"

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

	// Trigger immediate certificate provisioning via domain file
	// The new certificate manager will pick this up and immediately start provisioning
	log.Printf("Triggering immediate SSL certificate provisioning for %s...", *c.host)
	if err := c.triggerCertificateProvisioning(*c.host, certEmail); err != nil {
		log.Printf("Warning: Failed to trigger certificate provisioning: %v", err)
	} else {
		log.Printf("✅ SSL certificate provisioning triggered for %s", *c.host)
	}

	log.Printf("Route deployed successfully - SSL certificate will be provisioned automatically")
	return nil
}

// triggerCertificateProvisioning creates domain file to trigger immediate certificate provisioning
func (c *DeployCmd) triggerCertificateProvisioning(hostname, email string) error {
	// Create a domain registration file that the proxy will monitor
	domainFile := fmt.Sprintf("/tmp/luma-proxy-domain-%s", hostname)

	// Write domain info to a specific file
	domainInfo := fmt.Sprintf("%s|%s|%d", hostname, email, time.Now().Unix())
	if err := os.WriteFile(domainFile, []byte(domainInfo), 0644); err != nil {
		return fmt.Errorf("failed to create domain file: %w", err)
	}

	// Create a trigger file that signals the proxy to reload certificate domains
	triggerFile := "/tmp/luma-proxy-cert-reload-trigger"

	// Write the current timestamp to the trigger file
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	if err := os.WriteFile(triggerFile, []byte(timestamp), 0644); err != nil {
		return fmt.Errorf("failed to create certificate reload trigger: %w", err)
	}

	log.Printf("Created certificate provisioning trigger for immediate SSL setup")
	return nil
}

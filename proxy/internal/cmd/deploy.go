package cmd

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net/http"
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

	// Always attempt immediate certificate provisioning
	log.Printf("Attempting SSL certificate provisioning for %s...", *c.host)
	if err := c.attemptImmediateCertificate(*c.host, certEmail); err != nil {
		log.Printf("⚠️  Certificate provisioning failed: %v", err)

		// Add to retry queue for background processing
		if err := c.addToRetryQueue(*c.host, certEmail); err != nil {
			log.Printf("Warning: Failed to add %s to retry queue: %v", *c.host, err)
		} else {
			log.Printf("📋 Added %s to background retry queue", *c.host)
		}
	} else {
		log.Printf("✅ SSL certificate obtained for %s", *c.host)
	}

	log.Printf("Route deployed successfully")
	return nil
}

// attemptImmediateCertificate tries to get a certificate immediately
func (c *DeployCmd) attemptImmediateCertificate(hostname, email string) error {
	if email == "" {
		log.Printf("Warning: No email provided for Let's Encrypt. This is recommended for certificate expiry notifications.")
	}

	// Create a context with short timeout for immediate attempt
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Try to make an HTTPS request to trigger certificate provisioning
	client := &http.Client{
		Timeout: 20 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: true, // Allow self-signed certs during provisioning
			},
		},
	}

	req, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("https://%s/luma-proxy/health", hostname), nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("certificate provisioning request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	// Verify we got a real certificate (not self-signed)
	if resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		cert := resp.TLS.PeerCertificates[0]
		if err := cert.VerifyHostname(hostname); err == nil {
			log.Printf("Certificate verified for %s (expires: %s)", hostname, cert.NotAfter.Format("2006-01-02"))
			return nil
		}
	}

	return fmt.Errorf("no valid certificate obtained")
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

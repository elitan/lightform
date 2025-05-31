package cmd

import (
	"flag"
	"fmt"

	"github.com/elitan/luma-proxy/internal/cert"
	"github.com/elitan/luma-proxy/internal/config"
	"github.com/elitan/luma-proxy/internal/service"
)

// StatusCmd represents the status command
type StatusCmd struct {
	fs     *flag.FlagSet
	domain *string
}

// NewStatusCmd creates a new status command
func NewStatusCmd() *StatusCmd {
	cmd := &StatusCmd{
		fs: flag.NewFlagSet("status", flag.ExitOnError),
	}

	cmd.domain = cmd.fs.String("domain", "", "Check status for specific domain")

	return cmd
}

// Parse parses the command line arguments
func (c *StatusCmd) Parse(args []string) error {
	return c.fs.Parse(args)
}

// Execute executes the status command
func (c *StatusCmd) Execute() error {
	// Create configuration and service manager
	cfg := config.New()
	cfg.Load()

	serviceManager := service.NewManager(cfg)

	// Create retry queue to check status
	retryQueue := cert.NewRetryQueue()

	if *c.domain != "" {
		// Show status for specific domain
		return c.showDomainStatus(*c.domain, retryQueue, serviceManager)
	}

	// Show general status
	return c.showGeneralStatus(retryQueue, serviceManager)
}

// showDomainStatus shows status for a specific domain
func (c *StatusCmd) showDomainStatus(domain string, retryQueue *cert.RetryQueue, serviceManager *service.Manager) error {
	fmt.Printf("Certificate Status for %s:\n", domain)
	fmt.Printf("=====================================\n")

	// Check if domain is configured in services
	allServices := serviceManager.GetAllServices()
	configured := false
	for _, svc := range allServices {
		if svc.Host == domain {
			configured = true
			fmt.Printf("✅ Domain is configured in proxy\n")
			fmt.Printf("   Target: %s\n", svc.Target)
			fmt.Printf("   Project: %s\n", svc.Project)
			break
		}
	}

	if !configured {
		fmt.Printf("❌ Domain is not configured in proxy\n")
		return nil
	}

	// Check retry queue status
	if entry := retryQueue.Get(domain); entry != nil {
		fmt.Printf("🔄 Certificate in retry queue\n")
		fmt.Printf("   First attempt: %s\n", entry.FirstTry.Format("2006-01-02 15:04:05"))
		fmt.Printf("   Next retry: %s\n", entry.NextTry.Format("2006-01-02 15:04:05"))
		fmt.Printf("   Attempts: %d\n", entry.Attempts)
	} else {
		fmt.Printf("✅ Certificate not in retry queue (likely active or not yet requested)\n")
	}

	return nil
}

// showGeneralStatus shows general certificate status
func (c *StatusCmd) showGeneralStatus(retryQueue *cert.RetryQueue, serviceManager *service.Manager) error {
	fmt.Println("Certificate Management Status")
	fmt.Println("============================")

	// Show configured domains
	allServices := serviceManager.GetAllServices()
	fmt.Printf("Configured domains: %d\n", len(allServices))
	for _, svc := range allServices {
		fmt.Printf("  - %s → %s (project: %s)\n", svc.Host, svc.Target, svc.Project)
	}

	// Show retry queue status
	entries := retryQueue.List()
	fmt.Printf("\nCertificate retry queue: %d entries\n", len(entries))

	if len(entries) == 0 {
		fmt.Println("  (No domains pending certificate provisioning)")
	} else {
		fmt.Println("  Domains waiting for certificates:")
		for _, entry := range entries {
			fmt.Printf("    - %s (attempts: %d, added: %s)\n",
				entry.Hostname,
				entry.Attempts,
				entry.AddedAt.Format("2006-01-02 15:04:05"))
		}
	}

	// Show queue file location
	fmt.Printf("\nRetry queue file: /tmp/luma-proxy-cert-queue.json\n")
	fmt.Printf("Certificate cache: /var/lib/luma-proxy/certs/\n")

	return nil
}

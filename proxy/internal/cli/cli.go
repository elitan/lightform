package cli

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"text/tabwriter"
	"time"

	"github.com/elitan/luma/proxy/internal/cert"
	"github.com/elitan/luma/proxy/internal/health"
	"github.com/elitan/luma/proxy/internal/state"
)

type CLI struct {
	state         *state.State
	certManager   *cert.Manager
	healthChecker *health.Checker
}

// NewCLI creates a new CLI handler
func NewCLI(st *state.State, cm *cert.Manager, hc *health.Checker) *CLI {
	return &CLI{
		state:         st,
		certManager:   cm,
		healthChecker: hc,
	}
}

// Execute processes CLI commands
func (c *CLI) Execute(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("no command specified")
	}

	command := args[0]

	switch command {
	case "deploy":
		return c.deploy(args[1:])
	case "remove":
		return c.remove(args[1:])
	case "list":
		return c.list(args[1:])
	case "status":
		return c.status(args[1:])
	case "updatehealth":
		return c.updateHealth(args[1:])
	case "cert-status":
		return c.certStatus(args[1:])
	case "cert-renew":
		return c.certRenew(args[1:])
	case "set-staging":
		return c.setStaging(args[1:])
	case "switch":
		return c.switchTarget(args[1:])
	default:
		return fmt.Errorf("unknown command: %s", command)
	}
}

// deploy handles the deploy command
func (c *CLI) deploy(args []string) error {
	fs := flag.NewFlagSet("deploy", flag.ContinueOnError)
	host := fs.String("host", "", "Hostname to deploy")
	target := fs.String("target", "", "Target container:port")
	project := fs.String("project", "", "Project name")
	healthPath := fs.String("health-path", "/up", "Health check path")
	app := fs.String("app", "", "App name")
	ssl := fs.Bool("ssl", true, "Enable SSL")

	if err := fs.Parse(args); err != nil {
		return err
	}

	if *host == "" || *target == "" || *project == "" {
		return fmt.Errorf("missing required flags: --host, --target, --project")
	}

	// Deploy the host
	if err := c.state.DeployHost(*host, *target, *project, *app, *healthPath, *ssl); err != nil {
		return err
	}

	// Save state
	if err := c.state.Save(); err != nil {
		return err
	}

	log.Printf("[CLI] Deployed host %s -> %s", *host, *target)

	// Trigger immediate health check
	go c.healthChecker.CheckHost(*host)

	// If SSL is enabled, trigger certificate acquisition
	if *ssl {
		go func() {
			if err := c.certManager.AcquireCertificate(*host); err != nil {
				log.Printf("[CLI] Certificate acquisition failed: %v", err)
			}
		}()
	}

	return nil
}

// remove handles the remove command
func (c *CLI) remove(args []string) error {
	fs := flag.NewFlagSet("remove", flag.ContinueOnError)
	host := fs.String("host", "", "Hostname to remove")

	if err := fs.Parse(args); err != nil {
		return err
	}

	if *host == "" {
		return fmt.Errorf("missing required flag: --host")
	}

	// Remove the host
	if err := c.state.RemoveHost(*host); err != nil {
		return err
	}

	// Save state
	if err := c.state.Save(); err != nil {
		return err
	}

	log.Printf("[CLI] Removed host %s", *host)

	return nil
}

// list handles the list command
func (c *CLI) list(args []string) error {
	hosts := c.state.GetAllHosts()

	if len(hosts) == 0 {
		fmt.Println("No hosts configured")
		return nil
	}

	// Create a tab writer for formatted output
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "HOST\tTARGET\tSSL\tCERT STATUS\tHEALTH")

	for hostname, host := range hosts {
		sslEnabled := "No"
		if host.SSLEnabled {
			sslEnabled = "Yes"
		}

		certStatus := "-"
		if host.Certificate != nil {
			certStatus = host.Certificate.Status
		}

		health := "Unknown"
		if host.Healthy {
			health = "Healthy"
		} else if !host.LastHealthCheck.IsZero() {
			health = "Unhealthy"
		}

		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
			hostname, host.Target, sslEnabled, certStatus, health)
	}

	w.Flush()

	return nil
}

// status handles the status command (same as list but with different name for compatibility)
func (c *CLI) status(args []string) error {
	return c.list(args)
}

// updateHealth handles the updatehealth command
func (c *CLI) updateHealth(args []string) error {
	fs := flag.NewFlagSet("updatehealth", flag.ContinueOnError)
	host := fs.String("host", "", "Hostname to update")
	healthy := fs.Bool("healthy", false, "Health status")

	if err := fs.Parse(args); err != nil {
		return err
	}

	if *host == "" {
		return fmt.Errorf("missing required flag: --host")
	}

	// Update health status
	if err := c.state.UpdateHealthStatus(*host, *healthy); err != nil {
		return err
	}

	log.Printf("[CLI] Updated health status for %s to %v", *host, *healthy)

	return nil
}

// certStatus handles the cert-status command
func (c *CLI) certStatus(args []string) error {
	fs := flag.NewFlagSet("cert-status", flag.ContinueOnError)
	hostFlag := fs.String("host", "", "Hostname to check")

	if err := fs.Parse(args); err != nil {
		return err
	}

	// If no host specified, show all
	if *hostFlag == "" {
		hosts := c.state.GetAllHosts()

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "HOST\tSTATUS\tEXPIRES\tATTEMPTS")

		for hostname, host := range hosts {
			if host.Certificate == nil {
				continue
			}

			expires := "-"
			if !host.Certificate.ExpiresAt.IsZero() {
				expires = host.Certificate.ExpiresAt.Format("2006-01-02")
			}

			attempts := fmt.Sprintf("%d/%d",
				host.Certificate.AttemptCount,
				host.Certificate.MaxAttempts)

			fmt.Fprintf(w, "%s\t%s\t%s\t%s\n",
				hostname, host.Certificate.Status, expires, attempts)
		}

		w.Flush()
		return nil
	}

	// Show specific host
	host, _, err := c.state.GetHost(*hostFlag)
	if err != nil {
		return err
	}

	if host.Certificate == nil {
		fmt.Printf("No certificate configured for %s\n", *hostFlag)
		return nil
	}

	cert := host.Certificate
	fmt.Printf("Host: %s\n", *hostFlag)
	fmt.Printf("Status: %s\n", cert.Status)

	if cert.Status == "active" {
		fmt.Printf("Acquired: %s\n", cert.AcquiredAt.Format(time.RFC3339))
		fmt.Printf("Expires: %s\n", cert.ExpiresAt.Format(time.RFC3339))
		fmt.Printf("Days until expiry: %d\n",
			int(time.Until(cert.ExpiresAt).Hours()/24))
	} else if cert.Status == "acquiring" || cert.Status == "failed" {
		fmt.Printf("First attempt: %s\n", cert.FirstAttempt.Format(time.RFC3339))
		fmt.Printf("Last attempt: %s\n", cert.LastAttempt.Format(time.RFC3339))
		fmt.Printf("Attempts: %d/%d\n", cert.AttemptCount, cert.MaxAttempts)
		if !cert.NextAttempt.IsZero() {
			fmt.Printf("Next attempt: %s\n", cert.NextAttempt.Format(time.RFC3339))
		}
	}

	return nil
}

// certRenew handles the cert-renew command
func (c *CLI) certRenew(args []string) error {
	fs := flag.NewFlagSet("cert-renew", flag.ContinueOnError)
	host := fs.String("host", "", "Hostname to renew certificate for")

	if err := fs.Parse(args); err != nil {
		return err
	}

	if *host == "" {
		return fmt.Errorf("missing required flag: --host")
	}

	// Trigger certificate renewal
	go func() {
		if err := c.certManager.RenewCertificate(*host); err != nil {
			log.Printf("[CLI] Certificate renewal failed: %v", err)
		} else {
			log.Printf("[CLI] Certificate renewal initiated for %s", *host)
		}
	}()

	fmt.Printf("Certificate renewal initiated for %s\n", *host)

	return nil
}

// setStaging handles the set-staging command
func (c *CLI) setStaging(args []string) error {
	fs := flag.NewFlagSet("set-staging", flag.ContinueOnError)
	enabled := fs.Bool("enabled", false, "Enable Let's Encrypt staging mode")

	if err := fs.Parse(args); err != nil {
		return err
	}

	c.state.SetLetsEncryptStaging(*enabled)

	// Save state
	if err := c.state.Save(); err != nil {
		return err
	}

	mode := "production"
	if *enabled {
		mode = "staging"
	}

	log.Printf("[CLI] Set Let's Encrypt mode to %s", mode)
	fmt.Printf("Let's Encrypt mode set to %s\n", mode)

	return nil
}

// switchTarget handles the switch command for blue-green deployments
func (c *CLI) switchTarget(args []string) error {
	fs := flag.NewFlagSet("switch", flag.ContinueOnError)
	host := fs.String("host", "", "Hostname to switch")
	target := fs.String("target", "", "New target container:port")

	if err := fs.Parse(args); err != nil {
		return err
	}

	if *host == "" || *target == "" {
		return fmt.Errorf("missing required flags: --host, --target")
	}

	// Switch the target
	if err := c.state.SwitchTarget(*host, *target); err != nil {
		return err
	}

	// Save state
	if err := c.state.Save(); err != nil {
		return err
	}

	log.Printf("[CLI] Switched %s to target %s", *host, *target)

	// Trigger immediate health check on new target
	go c.healthChecker.CheckHost(*host)

	return nil
}

// OutputJSON outputs the result as JSON (for programmatic access)
func OutputJSON(data interface{}) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	encoder.Encode(data)
}

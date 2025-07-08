package cli

import (
	"flag"
	"fmt"
	"strconv"

	"github.com/elitan/luma/proxy/internal/api"
)

// HTTPCli provides command-line interface using HTTP API
type HTTPCli struct {
	client *api.HTTPClient
}

// NewHTTPBasedCLI creates a new HTTP-based CLI handler
func NewHTTPBasedCLI(client *api.HTTPClient) *HTTPCli {
	return &HTTPCli{
		client: client,
	}
}

// Execute processes CLI commands via HTTP API
func (c *HTTPCli) Execute(args []string) error {
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

// deploy handles the deploy command via HTTP API
func (c *HTTPCli) deploy(args []string) error {
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

	return c.client.Deploy(*host, *target, *project, *app, *healthPath, *ssl)
}

// remove handles the remove command via HTTP API
func (c *HTTPCli) remove(args []string) error {
	fs := flag.NewFlagSet("remove", flag.ContinueOnError)
	host := fs.String("host", "", "Hostname to remove")

	if err := fs.Parse(args); err != nil {
		return err
	}

	if *host == "" {
		return fmt.Errorf("missing required flag: --host")
	}

	return c.client.Remove(*host)
}

// list handles the list command via HTTP API
func (c *HTTPCli) list(args []string) error {
	return c.client.List()
}

// status handles the status command via HTTP API (same as list)
func (c *HTTPCli) status(args []string) error {
	return c.client.List()
}

// updateHealth handles the updatehealth command via HTTP API
func (c *HTTPCli) updateHealth(args []string) error {
	fs := flag.NewFlagSet("updatehealth", flag.ContinueOnError)
	host := fs.String("host", "", "Hostname to update")
	healthyStr := fs.String("healthy", "", "Health status (true/false)")

	if err := fs.Parse(args); err != nil {
		return err
	}

	if *host == "" || *healthyStr == "" {
		return fmt.Errorf("missing required flags: --host, --healthy")
	}

	healthy, err := strconv.ParseBool(*healthyStr)
	if err != nil {
		return fmt.Errorf("invalid healthy value: %s", *healthyStr)
	}

	return c.client.UpdateHealth(*host, healthy)
}

// certStatus handles the cert-status command via HTTP API
func (c *HTTPCli) certStatus(args []string) error {
	fs := flag.NewFlagSet("cert-status", flag.ContinueOnError)
	host := fs.String("host", "", "Hostname to check (optional)")

	if err := fs.Parse(args); err != nil {
		return err
	}

	return c.client.CertStatus(*host)
}

// certRenew handles the cert-renew command via HTTP API
func (c *HTTPCli) certRenew(args []string) error {
	fs := flag.NewFlagSet("cert-renew", flag.ContinueOnError)
	host := fs.String("host", "", "Hostname to renew certificate")

	if err := fs.Parse(args); err != nil {
		return err
	}

	if *host == "" {
		return fmt.Errorf("missing required flag: --host")
	}

	return c.client.CertRenew(*host)
}

// setStaging handles the set-staging command via HTTP API
func (c *HTTPCli) setStaging(args []string) error {
	fs := flag.NewFlagSet("set-staging", flag.ContinueOnError)
	enabledStr := fs.String("enabled", "", "Enable staging mode (true/false)")

	if err := fs.Parse(args); err != nil {
		return err
	}

	if *enabledStr == "" {
		return fmt.Errorf("missing required flag: --enabled")
	}

	enabled, err := strconv.ParseBool(*enabledStr)
	if err != nil {
		return fmt.Errorf("invalid enabled value: %s", *enabledStr)
	}

	return c.client.SetStaging(enabled)
}

// switchTarget handles the switch command via HTTP API
func (c *HTTPCli) switchTarget(args []string) error {
	fs := flag.NewFlagSet("switch", flag.ContinueOnError)
	host := fs.String("host", "", "Hostname to switch")
	target := fs.String("target", "", "New target container:port")

	if err := fs.Parse(args); err != nil {
		return err
	}

	if *host == "" || *target == "" {
		return fmt.Errorf("missing required flags: --host, --target")
	}

	return c.client.SwitchTarget(*host, *target)
}

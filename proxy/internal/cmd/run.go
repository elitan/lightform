package cmd

import (
	"flag"
	"log"

	"github.com/elitan/luma-proxy/internal/config"
	"github.com/elitan/luma-proxy/internal/proxy"
	"github.com/elitan/luma-proxy/internal/service"
)

// RunCmd represents the run command
type RunCmd struct {
	fs         *flag.FlagSet
	port       *string
	socketPath *string
	certEmail  *string
}

// NewRunCmd creates a new run command
func NewRunCmd() *RunCmd {
	cmd := &RunCmd{
		fs: flag.NewFlagSet("run", flag.ExitOnError),
	}

	cmd.port = cmd.fs.String("port", "443", "Public port for the HTTPS proxy server")
	cmd.socketPath = cmd.fs.String("socket-path", "/tmp/luma-proxy.sock", "Path to the Unix domain socket for management")

	// Certificate options (Let's Encrypt)
	cmd.certEmail = cmd.fs.String("cert-email", "", "Email address for Let's Encrypt registration (recommended)")

	return cmd
}

// Parse parses the command line arguments
func (c *RunCmd) Parse(args []string) error {
	return c.fs.Parse(args)
}

// Execute executes the run command
func (c *RunCmd) Execute() error {
	// Create and load configuration
	cfg := config.New()
	cfg.Load()

	// Update certificate configuration from command line flags
	if *c.certEmail != "" {
		cfg.Certs.Email = *c.certEmail
	}

	// Validate certificate configuration
	if cfg.Certs.Email == "" {
		log.Printf("Warning: No email provided for Let's Encrypt. This is recommended for certificate expiry notifications.")
	}

	// Create service manager
	serviceManager := service.NewManager(cfg)

	// Start health check routine for monitoring targets
	log.Printf("Starting background health check routine...")
	serviceManager.StartHealthCheckRoutine()

	// Create and start proxy server
	server := proxy.NewServer(*c.port, serviceManager, cfg.Certs)
	log.Printf("Starting proxy server with HTTPS on port %s", *c.port)

	return server.Start()
}

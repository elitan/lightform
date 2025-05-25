package cmd

import (
	"flag"
	"fmt"
	"log"

	"github.com/elitan/luma-proxy/internal/cert"
)

// StatusCmd represents the status command
type StatusCmd struct {
	fs *flag.FlagSet
}

// NewStatusCmd creates a new status command
func NewStatusCmd() *StatusCmd {
	cmd := &StatusCmd{
		fs: flag.NewFlagSet("status", flag.ExitOnError),
	}

	return cmd
}

// Parse parses the command line arguments
func (c *StatusCmd) Parse(args []string) error {
	return c.fs.Parse(args)
}

// Execute executes the status command
func (c *StatusCmd) Execute() error {
	log.Printf("Luma Proxy Status")
	log.Printf("================")

	// Load and display certificate retry queue status
	queue := cert.NewRetryQueue()
	entries := queue.List()

	if len(entries) == 0 {
		log.Printf("✅ No domains pending certificate provisioning")
		return nil
	}

	log.Printf("📋 Certificate Retry Queue (%d domains):", len(entries))
	log.Printf("")

	for _, entry := range entries {
		status := "⏳ Pending"
		if entry.Attempts > 0 {
			status = fmt.Sprintf("🔄 Retrying (attempt %d)", entry.Attempts)
		}

		log.Printf("  %s %s", status, entry.Hostname)
		log.Printf("    Email: %s", entry.Email)
		log.Printf("    Added: %s", entry.AddedAt.Format("2006-01-02 15:04:05"))

		if !entry.LastAttempt.IsZero() {
			log.Printf("    Last attempt: %s", entry.LastAttempt.Format("2006-01-02 15:04:05"))
		}

		log.Printf("")
	}

	log.Printf("Background retry service checks every 5 minutes.")
	log.Printf("Domains are automatically removed after successful certificate provisioning.")

	return nil
}

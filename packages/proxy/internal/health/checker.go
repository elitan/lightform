package health

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/elitan/iop/proxy/internal/state"
)

type Checker struct {
	state  *state.State
	client *http.Client
}

// NewChecker creates a new health checker
func NewChecker(st *state.State) *Checker {
	return &Checker{
		state: st,
		client: &http.Client{
			Timeout: 5 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 10,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

// Start begins the health checking loop
func (c *Checker) Start(ctx context.Context) {
	log.Println("[HEALTH] Starting health checker")

	// Initial health check for all hosts
	c.checkAllHosts()

	// Start periodic health checks
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			c.checkAllHosts()
		case <-ctx.Done():
			log.Println("[HEALTH] Stopping health checker")
			return
		}
	}
}

// CheckHost performs a health check on a specific host
func (c *Checker) CheckHost(hostname string) error {
	host, _, err := c.state.GetHost(hostname)
	if err != nil {
		return fmt.Errorf("host not found: %w", err)
	}

	// Build health check URL
	url := fmt.Sprintf("http://%s%s", host.Target, host.HealthPath)

	// Perform health check
	start := time.Now()
	resp, err := c.client.Get(url)
	duration := time.Since(start)

	if err != nil {
		log.Printf("[HEALTH] [%s] Check failed: %v", hostname, err)
		c.state.UpdateHealthStatus(hostname, false)
		return err
	}
	defer resp.Body.Close()

	// Check status code
	healthy := resp.StatusCode >= 200 && resp.StatusCode < 300
	c.state.UpdateHealthStatus(hostname, healthy)

	if healthy {
		log.Printf("[HEALTH] [%s] Check passed: %d OK (%dms)", hostname, resp.StatusCode, duration.Milliseconds())
	} else {
		log.Printf("[HEALTH] [%s] Check failed: %d (%dms)", hostname, resp.StatusCode, duration.Milliseconds())
	}

	return nil
}

// checkAllHosts performs health checks on all configured hosts
func (c *Checker) checkAllHosts() {
	hosts := c.state.GetAllHosts()

	for hostname := range hosts {
		go func(h string) {
			if err := c.CheckHost(h); err != nil {
				// Error already logged in CheckHost
			}
		}(hostname)
	}
}

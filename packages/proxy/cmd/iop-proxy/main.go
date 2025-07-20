package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/elitan/iop/proxy/internal/api"
	"github.com/elitan/iop/proxy/internal/cert"
	"github.com/elitan/iop/proxy/internal/cli"
	"github.com/elitan/iop/proxy/internal/health"
	"github.com/elitan/iop/proxy/internal/router"
	"github.com/elitan/iop/proxy/internal/state"
)

const (
	defaultStateFile = "/var/lib/iop-proxy/state.json"
)

func getStateFile() string {
	// Check if we can write to the default location
	if err := os.MkdirAll(filepath.Dir(defaultStateFile), 0755); err == nil {
		// We can create the directory, use the default
		return defaultStateFile
	}

	// Fallback to user's home directory for local testing
	currentUser, err := user.Current()
	if err != nil {
		// Final fallback to current directory
		return "./state.json"
	}

	localStateDir := filepath.Join(currentUser.HomeDir, ".iop-proxy")
	os.MkdirAll(localStateDir, 0755)
	return filepath.Join(localStateDir, "state.json")
}

func main() {
	// Check if this is a CLI command
	if len(os.Args) > 1 {
		if err := handleCLI(); err != nil {
			log.Fatal(err)
		}
		return
	}

	// Run as proxy server
	if err := runProxy(); err != nil {
		log.Fatal(err)
	}
}

// handleCLI handles CLI commands via HTTP API only
func handleCLI() error {
	httpClient := api.NewHTTPClient("http://localhost:8080")
	httpCli := cli.NewHTTPBasedCLI(httpClient)
	return httpCli.Execute(os.Args[1:])
}

func runProxy() error {
	log.Println("[PROXY] Starting Lightform proxy...")

	// Load state
	st := state.NewState(getStateFile())
	if err := st.Load(); err != nil {
		return fmt.Errorf("failed to load state: %w", err)
	}

	// Create certificate manager
	certManager, err := cert.NewManager(st)
	if err != nil {
		return fmt.Errorf("failed to create certificate manager: %w", err)
	}

	// Create health checker
	healthChecker := health.NewChecker(st)

	// Create router
	rt := router.NewRouter(st, certManager)

	// Create channel to signal when HTTP server is ready
	httpServerReady := make(chan struct{})

	// Create and start HTTP API server with readiness signal
	httpAPIServer := api.NewHTTPServerWithReadiness(st, certManager, healthChecker, httpServerReady)
	if err := httpAPIServer.Start(); err != nil {
		return fmt.Errorf("failed to start HTTP API server: %w", err)
	}

	// Create context for graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Wait group for background workers
	var wg sync.WaitGroup

	// Start health checker
	wg.Add(1)
	go func() {
		defer wg.Done()
		healthChecker.Start(ctx)
	}()

	// Start state persistence worker
	wg.Add(1)
	go func() {
		defer wg.Done()
		statePersistenceWorker(ctx, st)
	}()

	// Start certificate acquisition worker
	wg.Add(1)
	go func() {
		defer wg.Done()
		certificateAcquisitionWorker(ctx, st, certManager)
	}()

	// Start certificate renewal worker
	wg.Add(1)
	go func() {
		defer wg.Done()
		certificateRenewalWorker(ctx, st, certManager)
	}()

	// Start HTTP server
	httpServer := &http.Server{
		Addr:         ":80",
		Handler:      rt,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		log.Println("[PROXY] Starting HTTP server on :80")

		// Start listening in a separate goroutine and signal readiness
		ln, err := net.Listen("tcp", ":80")
		if err != nil {
			log.Printf("[PROXY] HTTP server listen error: %v", err)
			return
		}

		// Signal that HTTP server is ready to accept connections
		log.Println("[PROXY] HTTP server ready to accept connections on :80")
		close(httpServerReady)

		if err := httpServer.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("[PROXY] HTTP server error: %v", err)
		}
	}()

	// Start HTTPS server
	httpsServer := &http.Server{
		Addr:         ":443",
		Handler:      rt,
		TLSConfig:    rt.GetTLSConfig(),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		log.Println("[PROXY] Starting HTTPS server on :443")
		if err := httpsServer.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			log.Printf("[PROXY] HTTPS server error: %v", err)
		}
	}()

	// Wait for shutdown signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("[PROXY] Shutdown signal received, shutting down gracefully...")

	// Cancel context to stop background workers
	cancel()

	// Shutdown HTTP servers with timeout
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("[PROXY] HTTP server shutdown error: %v", err)
	}

	if err := httpsServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("[PROXY] HTTPS server shutdown error: %v", err)
	}

	// Shutdown HTTP API server
	if err := httpAPIServer.Stop(); err != nil {
		log.Printf("[PROXY] HTTP API server shutdown error: %v", err)
	}

	// Wait for background workers to finish
	wg.Wait()

	log.Println("[PROXY] Shutdown complete")
	return nil
}

// statePersistenceWorker periodically saves state to disk
func statePersistenceWorker(ctx context.Context, st *state.State) {
	log.Println("[WORKER] Starting state persistence worker")

	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if err := st.Save(); err != nil {
				log.Printf("[WORKER] Failed to save state: %v", err)
			}
		case <-ctx.Done():
			log.Println("[WORKER] Stopping state persistence worker")
			return
		}
	}
}

// certificateAcquisitionWorker processes pending certificate acquisitions
func certificateAcquisitionWorker(ctx context.Context, st *state.State, cm *cert.Manager) {
	log.Println("[WORKER] Starting certificate acquisition worker")

	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			processPendingCertificates(st, cm)
		case <-ctx.Done():
			log.Println("[WORKER] Stopping certificate acquisition worker")
			return
		}
	}
}

// processPendingCertificates checks for certificates that need acquisition
func processPendingCertificates(st *state.State, cm *cert.Manager) {
	hosts := st.GetAllHosts()
	log.Printf("[WORKER] Processing %d hosts for certificate acquisition", len(hosts))

	for hostname, host := range hosts {
		log.Printf("[WORKER] Checking host %s: SSL=%v, Cert=%v", hostname, host.SSLEnabled, host.Certificate != nil)

		if host.Certificate == nil || !host.SSLEnabled {
			if host.Certificate == nil {
				log.Printf("[WORKER] Host %s skipped: no certificate config", hostname)
			}
			if !host.SSLEnabled {
				log.Printf("[WORKER] Host %s skipped: SSL not enabled", hostname)
			}
			continue
		}

		cert := host.Certificate
		log.Printf("[WORKER] Host %s certificate status: %s, attempts: %d/%d", hostname, cert.Status, cert.AttemptCount, cert.MaxAttempts)

		// Check if we should attempt acquisition
		shouldAttempt := false

		switch cert.Status {
		case "pending":
			log.Printf("[WORKER] Host %s has pending certificate - will attempt acquisition", hostname)
			shouldAttempt = true
		case "acquiring":
			log.Printf("[WORKER] Host %s is acquiring, checking next attempt time", hostname)
			if time.Now().After(cert.NextAttempt) {
				log.Printf("[WORKER] Host %s next attempt time has passed - will attempt acquisition", hostname)
				shouldAttempt = true
			} else {
				log.Printf("[WORKER] Host %s next attempt scheduled for %v", hostname, cert.NextAttempt)
			}
		case "failed":
			log.Printf("[WORKER] Host %s certificate acquisition failed - not retrying", hostname)
			continue
		default:
			log.Printf("[WORKER] Host %s certificate status: %s - no action needed", hostname, cert.Status)
		}

		if shouldAttempt {
			log.Printf("[WORKER] Attempting certificate acquisition for %s", hostname)
			go func(h string) {
				if err := cm.AcquireCertificate(h); err != nil {
					log.Printf("[WORKER] Certificate acquisition failed for %s: %v", h, err)
				}
			}(hostname)
		}
	}
}

// certificateRenewalWorker checks for certificates that need renewal
func certificateRenewalWorker(ctx context.Context, st *state.State, cm *cert.Manager) {
	log.Println("[WORKER] Starting certificate renewal worker")

	// Check every 12 hours
	ticker := time.NewTicker(12 * time.Hour)
	defer ticker.Stop()

	// Initial check
	checkCertificateRenewals(st, cm)

	for {
		select {
		case <-ticker.C:
			checkCertificateRenewals(st, cm)
		case <-ctx.Done():
			log.Println("[WORKER] Stopping certificate renewal worker")
			return
		}
	}
}

// checkCertificateRenewals checks for certificates expiring within 30 days
func checkCertificateRenewals(st *state.State, cm *cert.Manager) {
	hosts := st.GetAllHosts()
	renewalThreshold := 30 * 24 * time.Hour // 30 days

	for hostname, host := range hosts {
		if host.Certificate == nil || host.Certificate.Status != "active" {
			continue
		}

		cert := host.Certificate
		timeUntilExpiry := time.Until(cert.ExpiresAt)

		if timeUntilExpiry < renewalThreshold {
			log.Printf("[WORKER] Certificate for %s expires in %d days, attempting renewal",
				hostname, int(timeUntilExpiry.Hours()/24))

			go func(h string) {
				if err := cm.RenewCertificate(h); err != nil {
					log.Printf("[WORKER] Certificate renewal failed for %s: %v", h, err)
				}
			}(hostname)
		}
	}
}

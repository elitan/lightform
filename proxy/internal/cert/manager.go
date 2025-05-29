package cert

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"golang.org/x/crypto/acme/autocert"
)

const defaultCertDir = "/var/lib/luma-proxy/certs"

// Manager handles TLS certificate acquisition and renewal
type Manager struct {
	certManager *autocert.Manager
	email       string
	domains     map[string]bool
	mutex       sync.RWMutex
	retryQueue  *RetryQueue
	stopChan    chan struct{}
}

// NewManager creates a new certificate manager
func NewManager(email string) *Manager {
	m := &Manager{
		email:      email,
		domains:    make(map[string]bool),
		retryQueue: NewRetryQueue(),
		stopChan:   make(chan struct{}),
	}

	m.initCertManager()
	m.startBackgroundRetry()
	return m
}

// initCertManager initializes the autocert.Manager
func (m *Manager) initCertManager() {
	m.certManager = &autocert.Manager{
		Cache:      autocert.DirCache(defaultCertDir),
		Prompt:     autocert.AcceptTOS,
		Email:      m.email,
		HostPolicy: m.hostPolicy,
		// RenewBefore: 30 * 24 * time.Hour, // Default is 30 days, explicitly setting is optional
	}
}

// hostPolicy implements the HostPolicy function for autocert
func (m *Manager) hostPolicy(ctx context.Context, host string) error {
	m.mutex.RLock()
	defer m.mutex.RUnlock()

	// If the domain is in our list, allow it
	if m.domains[host] {
		return nil
	}

	// Otherwise, reject it to avoid certificate issuance for non-configured domains
	return fmt.Errorf("domain %q not configured in Luma proxy", host)
}

// AddDomain adds a domain to the certificate manager
func (m *Manager) AddDomain(domain string) {
	m.mutex.Lock()
	defer m.mutex.Unlock()

	m.domains[domain] = true
	log.Printf("Added domain to certificate manager: %s", domain)
}

// GetCertificate returns a certificate for the specified server name
func (m *Manager) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	return m.certManager.GetCertificate(hello)
}

// HTTPHandler returns an HTTP handler for ACME HTTP-01 challenges
func (m *Manager) HTTPHandler(fallback http.Handler) http.Handler {
	return m.certManager.HTTPHandler(fallback)
}

// GetTLSConfig returns a TLS config that will use automatically provisioned certs
func (m *Manager) GetTLSConfig() *tls.Config {
	return m.certManager.TLSConfig()
}

// AddToRetryQueue adds a domain to the retry queue
func (m *Manager) AddToRetryQueue(hostname, email string) error {
	return m.retryQueue.Add(hostname, email)
}

// startBackgroundRetry starts the background certificate retry service
func (m *Manager) startBackgroundRetry() {
	go func() {
		log.Printf("Starting background certificate retry service")

		// Check every 5 minutes
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				m.processRetryQueue()
			case <-m.stopChan:
				log.Printf("Stopping background certificate retry service")
				return
			}
		}
	}()
}

// processRetryQueue ensures domains in the retry queue are added to the allowed list
func (m *Manager) processRetryQueue() {
	pending := m.retryQueue.GetPendingEntries()

	if len(pending) == 0 {
		return
	}

	log.Printf("Processing %d domains for certificate management", len(pending))

	for _, entry := range pending {
		log.Printf("Adding domain %s to certificate manager (attempt %d)", entry.Hostname, entry.Attempts+1)

		// Update attempt count
		m.retryQueue.UpdateAttempt(entry.Hostname)

		// Add domain to allowed list - this is all we need to do
		m.AddDomain(entry.Hostname)

		// Remove from retry queue immediately since we've done what we need
		if err := m.retryQueue.Remove(entry.Hostname); err != nil {
			log.Printf("Warning: Failed to remove %s from retry queue: %v", entry.Hostname, err)
		} else {
			log.Printf("✅ Domain %s is now configured for automatic certificate provisioning", entry.Hostname)
		}
	}
}

// Stop stops the background retry service
func (m *Manager) Stop() {
	close(m.stopChan)
}

// GetRetryQueueStatus returns the current status of the retry queue
func (m *Manager) GetRetryQueueStatus() []*QueueEntry {
	return m.retryQueue.List()
}

package cert

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"golang.org/x/crypto/acme/autocert"
)

const defaultCertDir = "/var/lib/luma-proxy/certs"

// Manager handles TLS certificate acquisition and renewal with proactive provisioning
type Manager struct {
	certManager *autocert.Manager
	email       string
	domains     map[string]bool
	mutex       sync.RWMutex
	retryQueue  *RetryQueue
	stopChan    chan struct{}
}

// NewManager creates a new certificate manager with proactive provisioning
func NewManager(email string) *Manager {
	m := &Manager{
		email:      email,
		domains:    make(map[string]bool),
		retryQueue: NewRetryQueue(),
		stopChan:   make(chan struct{}),
	}

	m.initCertManager()
	m.startBackgroundProcesses()
	return m
}

// initCertManager initializes the autocert.Manager
func (m *Manager) initCertManager() {
	m.certManager = &autocert.Manager{
		Cache:       autocert.DirCache(defaultCertDir),
		Prompt:      autocert.AcceptTOS,
		Email:       m.email,
		HostPolicy:  m.hostPolicy,
		RenewBefore: 30 * 24 * time.Hour, // Renew 30 days before expiration
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

// AddDomain adds a domain to the certificate manager and immediately tries to get a certificate
func (m *Manager) AddDomain(domain string) {
	m.mutex.Lock()
	m.domains[domain] = true
	m.mutex.Unlock()

	log.Printf("Added domain to certificate manager: %s", domain)

	// NEW: Immediately attempt certificate provisioning in background
	go m.provisionCertificateAsync(domain)
}

// provisionCertificateAsync attempts to provision a certificate immediately for a domain
func (m *Manager) provisionCertificateAsync(domain string) {
	log.Printf("Attempting immediate certificate provisioning for %s", domain)

	// Try to get certificate using a fake TLS ClientHello
	_, err := m.certManager.GetCertificate(&tls.ClientHelloInfo{
		ServerName: domain,
	})

	if err != nil {
		log.Printf("Certificate provisioning failed for %s: %v", domain, err)
		// Add to retry queue for background retries
		m.scheduleRetry(domain)
	} else {
		log.Printf("Certificate successfully provisioned for %s", domain)
	}
}

// scheduleRetry adds a domain to the retry queue with 3-day timeout
func (m *Manager) scheduleRetry(domain string) {
	// Check if we've been trying for more than 3 days
	if existing := m.retryQueue.Get(domain); existing != nil {
		if time.Since(existing.FirstTry) > 72*time.Hour {
			log.Printf("Giving up on certificate for %s after 3 days", domain)
			m.retryQueue.Remove(domain)
			return
		}
	}

	m.retryQueue.Add(RetryEntry{
		Domain:   domain,
		FirstTry: time.Now(),
		NextTry:  time.Now().Add(5 * time.Minute),
	})

	log.Printf("Scheduled retry for %s in 5 minutes", domain)
}

// startBackgroundProcesses starts retry and renewal background services
func (m *Manager) startBackgroundProcesses() {
	// Start retry processor - check every minute
	go func() {
		log.Printf("Starting certificate retry processor")
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				m.processRetries()
			case <-m.stopChan:
				log.Printf("Stopping certificate retry processor")
				return
			}
		}
	}()

	// Start renewal checker - check daily
	go func() {
		log.Printf("Starting certificate renewal checker")
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				m.checkRenewals()
			case <-m.stopChan:
				log.Printf("Stopping certificate renewal checker")
				return
			}
		}
	}()
}

// processRetries handles retry logic for failed certificate requests
func (m *Manager) processRetries() {
	entries := m.retryQueue.GetReadyEntries()
	if len(entries) == 0 {
		return
	}

	log.Printf("Processing %d certificate retries", len(entries))

	for _, entry := range entries {
		go m.retryProvisioning(entry)
	}
}

// retryProvisioning retries certificate provisioning for a domain
func (m *Manager) retryProvisioning(entry RetryEntry) {
	log.Printf("Retrying certificate provisioning for %s (attempt %d)", entry.Domain, entry.Attempts+1)

	_, err := m.certManager.GetCertificate(&tls.ClientHelloInfo{
		ServerName: entry.Domain,
	})

	if err != nil {
		log.Printf("Certificate retry failed for %s: %v", entry.Domain, err)
		// Update attempt count and schedule next retry
		m.retryQueue.UpdateAttempt(entry.Domain)
		// Next retry will be scheduled by UpdateAttempt if within limits
	} else {
		log.Printf("Certificate successfully provisioned for %s on retry", entry.Domain)
		m.retryQueue.Remove(entry.Domain)
	}
}

// checkRenewals checks for certificates that need renewal (30 days before expiration)
func (m *Manager) checkRenewals() {
	log.Printf("Checking certificate renewals...")

	m.mutex.RLock()
	domains := make([]string, 0, len(m.domains))
	for domain := range m.domains {
		domains = append(domains, domain)
	}
	m.mutex.RUnlock()

	for _, domain := range domains {
		go m.checkDomainRenewal(domain)
	}
}

// checkDomainRenewal checks if a specific domain needs renewal
func (m *Manager) checkDomainRenewal(domain string) {
	// Get current certificate
	tlsCert, err := m.getCertificateFromCache(domain)
	if err != nil {
		log.Printf("No certificate found for %s during renewal check: %v", domain, err)
		return
	}

	// Parse the leaf certificate to get expiration info
	if tlsCert.Leaf == nil && len(tlsCert.Certificate) > 0 {
		// Parse the certificate if leaf is not set
		cert, err := x509.ParseCertificate(tlsCert.Certificate[0])
		if err != nil {
			log.Printf("Failed to parse certificate for %s: %v", domain, err)
			return
		}
		tlsCert.Leaf = cert
	}

	if tlsCert.Leaf == nil {
		log.Printf("No leaf certificate found for %s", domain)
		return
	}

	// Check if it needs renewal (30 days before expiration)
	daysUntilExpiry := time.Until(tlsCert.Leaf.NotAfter).Hours() / 24
	if daysUntilExpiry <= 30 {
		log.Printf("Certificate for %s expires in %.0f days, renewing", domain, daysUntilExpiry)
		m.renewCertificate(domain)
	}
}

// renewCertificate forces renewal of a certificate
func (m *Manager) renewCertificate(domain string) {
	log.Printf("Renewing certificate for %s", domain)

	// Force renewal by requesting a new certificate
	_, err := m.certManager.GetCertificate(&tls.ClientHelloInfo{
		ServerName: domain,
	})

	if err != nil {
		log.Printf("Certificate renewal failed for %s: %v", domain, err)
		// Use same retry system as initial provisioning
		m.scheduleRetry(domain)
	} else {
		log.Printf("Certificate successfully renewed for %s", domain)
	}
}

// getCertificateFromCache retrieves a certificate from autocert cache
func (m *Manager) getCertificateFromCache(domain string) (*tls.Certificate, error) {
	// This is a simplified way to check if we have a certificate
	// In practice, autocert handles this internally
	cert, err := m.certManager.GetCertificate(&tls.ClientHelloInfo{
		ServerName: domain,
	})
	return cert, err
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

// Stop stops all background processes
func (m *Manager) Stop() {
	close(m.stopChan)
}

// GetRetryQueueStatus returns the current status of the retry queue
func (m *Manager) GetRetryQueueStatus() []*QueueEntry {
	return m.retryQueue.List()
}

// GetDomainStatus returns basic certificate status for a domain
func (m *Manager) GetDomainStatus(domain string) string {
	// Check if we have a certificate
	_, err := m.getCertificateFromCache(domain)
	if err == nil {
		return "ACTIVE"
	}

	// Check if in retry queue
	if entry := m.retryQueue.Get(domain); entry != nil {
		return "RETRYING"
	}

	return "NOT_FOUND"
}

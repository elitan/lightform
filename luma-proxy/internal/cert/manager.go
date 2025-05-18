package cert

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"net/http"
	"sync"

	"golang.org/x/crypto/acme/autocert"
)

const defaultCertDir = "/var/lib/luma-proxy/certs"

// Manager handles TLS certificate acquisition and renewal
type Manager struct {
	certManager *autocert.Manager
	email       string
	domains     map[string]bool
	mutex       sync.RWMutex
}

// NewManager creates a new certificate manager
func NewManager(email string) *Manager {
	m := &Manager{
		email:   email,
		domains: make(map[string]bool),
	}

	m.initCertManager()
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

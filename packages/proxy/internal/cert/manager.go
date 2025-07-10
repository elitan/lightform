package cert

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/elitan/lightform/proxy/internal/state"
	"golang.org/x/crypto/acme"
)

type Manager struct {
	state      *state.State
	client     *acme.Client
	accountKey crypto.Signer
	httpTokens sync.Map // map[token]keyAuth for HTTP-01 challenges
	certCache  sync.Map // map[hostname]*tls.Certificate
	mu         sync.Mutex
}

// NewManager creates a new certificate manager
func NewManager(st *state.State) (*Manager, error) {
	m := &Manager{
		state: st,
	}

	// Load or create account key
	accountKey, err := m.loadOrCreateAccountKey()
	if err != nil {
		return nil, fmt.Errorf("failed to load account key: %w", err)
	}
	m.accountKey = accountKey

	// Initialize ACME client
	if err := m.initACMEClient(); err != nil {
		return nil, fmt.Errorf("failed to initialize ACME client: %w", err)
	}

	// Register account if needed
	if err := m.registerAccount(); err != nil {
		return nil, fmt.Errorf("failed to register account: %w", err)
	}

	// Load existing certificates
	if err := m.loadCertificates(); err != nil {
		return nil, fmt.Errorf("failed to load certificates: %w", err)
	}

	return m, nil
}

// initACMEClient initializes or reinitializes the ACME client with current configuration
func (m *Manager) initACMEClient() error {
	// Create ACME client with proper HTTP transport configuration
	httpClient := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 15 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
			IdleConnTimeout:       30 * time.Second,
			DisableKeepAlives:     false,
		},
	}

	m.client = &acme.Client{
		Key:          m.accountKey,
		DirectoryURL: m.state.LetsEncrypt.DirectoryURL,
		HTTPClient:   httpClient,
	}

	log.Printf("[CERT] ACME client configured with directory URL: %s", m.state.LetsEncrypt.DirectoryURL)
	return nil
}

// UpdateACMEClient updates the ACME client when configuration changes (e.g., staging mode)
func (m *Manager) UpdateACMEClient() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	log.Printf("[CERT] Updating ACME client configuration...")

	if err := m.initACMEClient(); err != nil {
		return fmt.Errorf("failed to update ACME client: %w", err)
	}

	// Re-register account with new directory if needed
	if err := m.registerAccount(); err != nil {
		return fmt.Errorf("failed to re-register account: %w", err)
	}

	log.Printf("[CERT] ACME client updated successfully with directory URL: %s", m.state.LetsEncrypt.DirectoryURL)
	return nil
}

// GetCertificate returns a certificate for the given hostname
func (m *Manager) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	hostname := hello.ServerName

	// Check cache first
	if cert, ok := m.certCache.Load(hostname); ok {
		return cert.(*tls.Certificate), nil
	}

	// Check if we have a certificate on disk
	host, _, err := m.state.GetHost(hostname)
	if err != nil {
		return nil, fmt.Errorf("unknown host: %s", hostname)
	}

	if host.Certificate == nil || host.Certificate.Status != "active" {
		return nil, fmt.Errorf("no active certificate for host: %s", hostname)
	}

	cert, err := m.loadCertificate(hostname, host.Certificate.CertFile, host.Certificate.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("failed to load certificate: %w", err)
	}

	// Cache the certificate
	m.certCache.Store(hostname, cert)

	return cert, nil
}

// ServeHTTPChallenge handles ACME HTTP-01 challenges
func (m *Manager) ServeHTTPChallenge(token string) (string, bool) {
	if keyAuth, ok := m.httpTokens.Load(token); ok {
		return keyAuth.(string), true
	}
	return "", false
}

// AcquireCertificate attempts to acquire a certificate for the given hostname
func (m *Manager) AcquireCertificate(hostname string) error {
	log.Printf("[CERT] [%s] Certificate acquisition request received", hostname)

	// Use a per-hostname mutex to prevent concurrent acquisition attempts for the same domain
	// This prevents ACME client race conditions that cause hanging
	m.mu.Lock()
	defer m.mu.Unlock()

	log.Printf("[CERT] [%s] Acquired certificate acquisition lock", hostname)

	host, _, err := m.state.GetHost(hostname)
	if err != nil {
		log.Printf("[CERT] [%s] Host not found in state: %v", hostname, err)
		return fmt.Errorf("host not found: %w", err)
	}

	if host.Certificate == nil {
		log.Printf("[CERT] [%s] Initializing new certificate status", hostname)
		host.Certificate = &state.CertificateStatus{
			Status:       "acquiring",
			FirstAttempt: time.Now(),
			MaxAttempts:  144,
		}
	}

	// Check if already acquiring or active - avoid duplicate work
	if host.Certificate.Status == "active" {
		log.Printf("[CERT] [%s] Certificate already active, skipping acquisition", hostname)
		return nil
	}

	if host.Certificate.Status == "acquiring" && host.Certificate.AttemptCount > 0 && time.Since(host.Certificate.LastAttempt) < 30*time.Second {
		log.Printf("[CERT] [%s] Recent acquisition attempt in progress (last attempt %v ago), skipping", hostname, time.Since(host.Certificate.LastAttempt))
		return nil
	}

	// Update status
	host.Certificate.Status = "acquiring"
	host.Certificate.LastAttempt = time.Now()
	host.Certificate.AttemptCount++

	log.Printf("[CERT] [%s] Starting certificate acquisition (attempt %d/%d)", hostname, host.Certificate.AttemptCount, host.Certificate.MaxAttempts)

	// Create order with shorter timeout to prevent hanging
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	log.Printf("[CERT] [%s] Creating ACME order with Let's Encrypt (timeout: 30s)", hostname)
	log.Printf("[CERT] [%s] ACME directory URL: %s", hostname, m.client.DirectoryURL)
	log.Printf("[CERT] [%s] Attempting AuthorizeOrder for domain: %s", hostname, hostname)

	orderStart := time.Now()
	order, err := m.client.AuthorizeOrder(ctx, acme.DomainIDs(hostname))
	orderDuration := time.Since(orderStart)

	if err != nil {
		log.Printf("[CERT] [%s] Failed to create ACME order after %v: %v", hostname, orderDuration, err)
		if ctx.Err() == context.DeadlineExceeded {
			log.Printf("[CERT] [%s] ACME order creation timed out after 30 seconds", hostname)
		}
		m.updateCertificateError(hostname, err)
		return err
	}
	log.Printf("[CERT] [%s] ACME order created successfully in %v (status: %s)", hostname, orderDuration, order.Status)

	// Complete challenges
	log.Printf("[CERT] [%s] Processing %d authorization(s)", hostname, len(order.AuthzURLs))
	for i, authzURL := range order.AuthzURLs {
		log.Printf("[CERT] [%s] Processing authorization %d/%d", hostname, i+1, len(order.AuthzURLs))

		authz, err := m.client.GetAuthorization(ctx, authzURL)
		if err != nil {
			log.Printf("[CERT] [%s] Failed to get authorization %d: %v", hostname, i+1, err)
			m.updateCertificateError(hostname, err)
			return err
		}

		if authz.Status == acme.StatusValid {
			log.Printf("[CERT] [%s] Authorization %d already valid, skipping", hostname, i+1)
			continue
		}

		// Find HTTP-01 challenge
		var challenge *acme.Challenge
		log.Printf("[CERT] [%s] Looking for HTTP-01 challenge among %d challenge(s)", hostname, len(authz.Challenges))
		for j, c := range authz.Challenges {
			log.Printf("[CERT] [%s] Challenge %d: type=%s, status=%s", hostname, j+1, c.Type, c.Status)
			if c.Type == "http-01" {
				challenge = c
				break
			}
		}

		if challenge == nil {
			err := fmt.Errorf("no HTTP-01 challenge found among %d challenges", len(authz.Challenges))
			log.Printf("[CERT] [%s] %v", hostname, err)
			m.updateCertificateError(hostname, err)
			return err
		}

		log.Printf("[CERT] [%s] Found HTTP-01 challenge: token=%s, status=%s", hostname, challenge.Token, challenge.Status)

		// Prepare challenge response
		keyAuth, err := m.client.HTTP01ChallengeResponse(challenge.Token)
		if err != nil {
			log.Printf("[CERT] [%s] Failed to prepare challenge response: %v", hostname, err)
			m.updateCertificateError(hostname, err)
			return err
		}

		// Store challenge token
		m.httpTokens.Store(challenge.Token, keyAuth)
		defer m.httpTokens.Delete(challenge.Token)

		log.Printf("[CERT] [%s] ACME challenge created: http-01", hostname)
		log.Printf("[CERT] [%s] Challenge URL: /.well-known/acme-challenge/%s", hostname, challenge.Token)
		log.Printf("[CERT] [%s] Challenge key authorization stored", hostname)

		// Accept challenge
		log.Printf("[CERT] [%s] Accepting ACME challenge", hostname)
		if _, err := m.client.Accept(ctx, challenge); err != nil {
			log.Printf("[CERT] [%s] Failed to accept challenge: %v", hostname, err)
			m.updateCertificateError(hostname, err)
			return err
		}
		log.Printf("[CERT] [%s] ACME challenge accepted, waiting for validation", hostname)

		// Wait for challenge to complete
		log.Printf("[CERT] [%s] Waiting for challenge validation...", hostname)
		authz, err = m.client.WaitAuthorization(ctx, authz.URI)
		if err != nil {
			log.Printf("[CERT] [%s] Challenge validation failed: %v", hostname, err)
			if authz != nil && authz.Status == acme.StatusInvalid {
				log.Printf("[CERT] [%s] DNS validation failed: NXDOMAIN", hostname)
			}
			m.updateCertificateError(hostname, err)
			return err
		}

		log.Printf("[CERT] [%s] ACME challenge validation successful", hostname)
	}

	// Wait for order to be ready
	log.Printf("[CERT] [%s] Waiting for ACME order to be ready for finalization", hostname)
	order, err = m.client.WaitOrder(ctx, order.URI)
	if err != nil {
		log.Printf("[CERT] [%s] Failed to wait for order: %v", hostname, err)
		m.updateCertificateError(hostname, err)
		return err
	}
	log.Printf("[CERT] [%s] ACME order is ready for finalization", hostname)

	// Create certificate request
	log.Printf("[CERT] [%s] Generating private key for certificate", hostname)
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Printf("[CERT] [%s] Failed to generate key: %v", hostname, err)
		m.updateCertificateError(hostname, err)
		return err
	}

	template := &x509.CertificateRequest{
		Subject:  pkix.Name{CommonName: hostname},
		DNSNames: []string{hostname},
	}

	log.Printf("[CERT] [%s] Creating certificate signing request (CSR)", hostname)
	csr, err := x509.CreateCertificateRequest(rand.Reader, template, key)
	if err != nil {
		log.Printf("[CERT] [%s] Failed to create CSR: %v", hostname, err)
		m.updateCertificateError(hostname, err)
		return err
	}

	// Finalize order
	log.Printf("[CERT] [%s] Finalizing ACME order with CSR", hostname)
	derCerts, _, err := m.client.CreateOrderCert(ctx, order.FinalizeURL, csr, true)
	if err != nil {
		log.Printf("[CERT] [%s] Failed to finalize order: %v", hostname, err)
		m.updateCertificateError(hostname, err)
		return err
	}
	log.Printf("[CERT] [%s] ACME order finalized, certificate obtained", hostname)

	// Save certificate
	log.Printf("[CERT] [%s] Saving certificate to disk", hostname)
	certPath := filepath.Join("/var/lib/lightform-proxy/certs", hostname, "cert.pem")
	keyPath := filepath.Join("/var/lib/lightform-proxy/certs", hostname, "key.pem")

	// For local testing, use home directory if we can't write to /var/lib
	if os.Getuid() != 0 {
		if homeDir, err := os.UserHomeDir(); err == nil {
			localCertDir := filepath.Join(homeDir, ".lightform-proxy", "certs", hostname)
			certPath = filepath.Join(localCertDir, "cert.pem")
			keyPath = filepath.Join(localCertDir, "key.pem")
		}
	}

	if err := m.saveCertificate(hostname, derCerts, key); err != nil {
		log.Printf("[CERT] [%s] Failed to save certificate: %v", hostname, err)
		m.updateCertificateError(hostname, err)
		return err
	}
	log.Printf("[CERT] [%s] Certificate saved to disk: %s", hostname, certPath)

	// Parse certificate to get expiry
	cert, err := x509.ParseCertificate(derCerts[0])
	if err != nil {
		log.Printf("[CERT] [%s] Failed to parse certificate: %v", hostname, err)
		m.updateCertificateError(hostname, err)
		return err
	}

	// Update state
	status := &state.CertificateStatus{
		Status:     "active",
		AcquiredAt: time.Now(),
		ExpiresAt:  cert.NotAfter,
		CertFile:   certPath,
		KeyFile:    keyPath,
	}

	log.Printf("[CERT] [%s] Updating certificate status to active (expires: %s)", hostname, cert.NotAfter.Format(time.RFC3339))
	if err := m.state.UpdateCertificateStatus(hostname, status); err != nil {
		log.Printf("[CERT] [%s] Failed to update certificate status: %v", hostname, err)
		return err
	}

	// Clear cache to force reload
	m.certCache.Delete(hostname)

	log.Printf("[CERT] [%s] Certificate issued successfully", hostname)

	// Small delay to ensure all systems are synchronized
	time.Sleep(500 * time.Millisecond)
	log.Printf("[CERT] [%s] Certificate acquisition completed and synchronized", hostname)

	return nil
}

// RenewCertificate attempts to renew a certificate
func (m *Manager) RenewCertificate(hostname string) error {
	host, _, err := m.state.GetHost(hostname)
	if err != nil {
		return fmt.Errorf("host not found: %w", err)
	}

	if host.Certificate == nil {
		return fmt.Errorf("no certificate to renew")
	}

	// Update renewal attempt
	host.Certificate.LastRenewalAttempt = time.Now()
	host.Certificate.RenewalAttempts++
	host.Certificate.Status = "renewing"

	// Attempt acquisition (same process as initial acquisition)
	if err := m.AcquireCertificate(hostname); err != nil {
		// Restore previous status if renewal fails
		host.Certificate.Status = "active"
		return err
	}

	// Reset renewal attempts on success
	host.Certificate.RenewalAttempts = 0

	return nil
}

// loadOrCreateAccountKey loads or creates the ACME account key
func (m *Manager) loadOrCreateAccountKey() (crypto.Signer, error) {
	keyPath := m.state.LetsEncrypt.AccountKeyFile

	// For local testing, use a fallback directory if we can't write to /var/lib
	if _, err := os.Stat(filepath.Dir(keyPath)); os.IsNotExist(err) {
		if os.Getuid() != 0 { // Not running as root
			homeDir, err := os.UserHomeDir()
			if err == nil {
				localDir := filepath.Join(homeDir, ".lightform-proxy", "certs")
				keyPath = filepath.Join(localDir, "account.key")
				// Update the state to use the local path
				m.state.LetsEncrypt.AccountKeyFile = keyPath
			}
		}
	}

	// Ensure directory exists
	if err := os.MkdirAll(filepath.Dir(keyPath), 0700); err != nil {
		return nil, fmt.Errorf("failed to create key directory: %w", err)
	}

	// Try to load existing key
	if data, err := os.ReadFile(keyPath); err == nil {
		block, _ := pem.Decode(data)
		if block == nil {
			return nil, fmt.Errorf("failed to decode PEM block")
		}

		key, err := x509.ParseECPrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("failed to parse private key: %w", err)
		}

		return key, nil
	}

	// Generate new key
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("failed to generate key: %w", err)
	}

	// Save key
	keyBytes, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal key: %w", err)
	}

	block := &pem.Block{
		Type:  "EC PRIVATE KEY",
		Bytes: keyBytes,
	}

	if err := os.WriteFile(keyPath, pem.EncodeToMemory(block), 0600); err != nil {
		return nil, fmt.Errorf("failed to save key: %w", err)
	}

	return key, nil
}

// registerAccount registers the ACME account
func (m *Manager) registerAccount() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	acct := &acme.Account{}

	// Add email to account if provided
	if m.state.LetsEncrypt.Email != "" {
		acct.Contact = []string{"mailto:" + m.state.LetsEncrypt.Email}
		log.Printf("[CERT] Registering ACME account with email: %s", m.state.LetsEncrypt.Email)
	} else {
		log.Println("[CERT] Registering ACME account without email")
	}

	_, err := m.client.Register(ctx, acct, acme.AcceptTOS)
	if err != nil && err != acme.ErrAccountAlreadyExists {
		return fmt.Errorf("failed to register account: %w", err)
	}

	log.Println("[CERT] ACME account registration completed successfully")
	return nil
}

// loadCertificates loads all certificates from disk
func (m *Manager) loadCertificates() error {
	hosts := m.state.GetAllHosts()

	for hostname, host := range hosts {
		if host.Certificate != nil && host.Certificate.Status == "active" {
			cert, err := m.loadCertificate(hostname, host.Certificate.CertFile, host.Certificate.KeyFile)
			if err != nil {
				log.Printf("[CERT] [%s] Failed to load certificate: %v", hostname, err)
				continue
			}

			m.certCache.Store(hostname, cert)
		}
	}

	return nil
}

// loadCertificate loads a certificate from disk
func (m *Manager) loadCertificate(hostname, certPath, keyPath string) (*tls.Certificate, error) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read certificate: %w", err)
	}

	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read key: %w", err)
	}

	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("failed to parse certificate: %w", err)
	}

	return &cert, nil
}

// saveCertificate saves a certificate to disk
func (m *Manager) saveCertificate(hostname string, derCerts [][]byte, key crypto.PrivateKey) error {
	certDir := filepath.Join("/var/lib/lightform-proxy/certs", hostname)
	if err := os.MkdirAll(certDir, 0755); err != nil {
		return fmt.Errorf("failed to create certificate directory: %w", err)
	}

	// Save certificate
	certPath := filepath.Join(certDir, "cert.pem")
	certFile, err := os.Create(certPath)
	if err != nil {
		return fmt.Errorf("failed to create certificate file: %w", err)
	}
	defer certFile.Close()

	for _, derCert := range derCerts {
		block := &pem.Block{
			Type:  "CERTIFICATE",
			Bytes: derCert,
		}
		if err := pem.Encode(certFile, block); err != nil {
			return fmt.Errorf("failed to encode certificate: %w", err)
		}
	}

	// Save key
	keyPath := filepath.Join(certDir, "key.pem")
	keyBytes, err := x509.MarshalECPrivateKey(key.(*ecdsa.PrivateKey))
	if err != nil {
		return fmt.Errorf("failed to marshal key: %w", err)
	}

	block := &pem.Block{
		Type:  "EC PRIVATE KEY",
		Bytes: keyBytes,
	}

	if err := os.WriteFile(keyPath, pem.EncodeToMemory(block), 0600); err != nil {
		return fmt.Errorf("failed to save key: %w", err)
	}

	return nil
}

// updateCertificateError updates certificate status after an error
func (m *Manager) updateCertificateError(hostname string, err error) {
	log.Printf("[CERT] [%s] Certificate acquisition error occurred: %v", hostname, err)

	host, _, _ := m.state.GetHost(hostname)
	if host == nil || host.Certificate == nil {
		log.Printf("[CERT] [%s] Cannot update certificate error - host or certificate is nil", hostname)
		return
	}

	log.Printf("[CERT] [%s] Current status: %s, attempts: %d/%d", hostname, host.Certificate.Status, host.Certificate.AttemptCount, host.Certificate.MaxAttempts)

	// Schedule next attempt
	host.Certificate.NextAttempt = time.Now().Add(10 * time.Minute)

	// Check if we've exceeded max attempts
	if host.Certificate.AttemptCount >= host.Certificate.MaxAttempts {
		host.Certificate.Status = "failed"
		log.Printf("[CERT] [%s] Acquisition failed after %d attempts, marking as failed", hostname, host.Certificate.MaxAttempts)
		log.Printf("[CERT] [%s] Final error: %v", hostname, err)
	} else {
		log.Printf("[CERT] [%s] Acquisition failed, scheduling retry in 10 minutes", hostname)
		log.Printf("[CERT] [%s] Attempt %d/%d, next attempt: %s",
			hostname,
			host.Certificate.AttemptCount,
			host.Certificate.MaxAttempts,
			host.Certificate.NextAttempt.Format(time.RFC3339))
		log.Printf("[CERT] [%s] Error details: %v", hostname, err)
	}

	if err := m.state.UpdateCertificateStatus(hostname, host.Certificate); err != nil {
		log.Printf("[CERT] [%s] Failed to update certificate status in state: %v", hostname, err)
	} else {
		log.Printf("[CERT] [%s] Certificate status updated successfully", hostname)
	}
}

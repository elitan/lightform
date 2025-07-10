package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type State struct {
	mu sync.RWMutex

	Projects    map[string]*Project `json:"projects"`
	LetsEncrypt *LetsEncryptConfig  `json:"lets_encrypt"`
	Metadata    *Metadata           `json:"metadata"`

	modified bool
	filePath string
}

type Project struct {
	Hosts map[string]*Host `json:"hosts"`
}

type Host struct {
	Target          string             `json:"target"`
	App             string             `json:"app"`
	HealthPath      string             `json:"health_path"`
	CreatedAt       time.Time          `json:"created_at"`
	SSLEnabled      bool               `json:"ssl_enabled"`
	SSLRedirect     bool               `json:"ssl_redirect"`
	ForwardHeaders  bool               `json:"forward_headers"`
	ResponseTimeout string             `json:"response_timeout"`
	Certificate     *CertificateStatus `json:"certificate,omitempty"`

	// Runtime state (not persisted)
	Healthy         bool      `json:"-"`
	LastHealthCheck time.Time `json:"-"`
}

type CertificateStatus struct {
	Status             string    `json:"status"`
	AcquiredAt         time.Time `json:"acquired_at,omitempty"`
	ExpiresAt          time.Time `json:"expires_at,omitempty"`
	LastRenewalAttempt time.Time `json:"last_renewal_attempt,omitempty"`
	RenewalAttempts    int       `json:"renewal_attempts,omitempty"`
	CertFile           string    `json:"cert_file,omitempty"`
	KeyFile            string    `json:"key_file,omitempty"`

	// For acquiring status
	FirstAttempt time.Time `json:"first_attempt,omitempty"`
	LastAttempt  time.Time `json:"last_attempt,omitempty"`
	NextAttempt  time.Time `json:"next_attempt,omitempty"`
	AttemptCount int       `json:"attempt_count,omitempty"`
	MaxAttempts  int       `json:"max_attempts,omitempty"`
}

type LetsEncryptConfig struct {
	AccountKeyFile string `json:"account_key_file"`
	DirectoryURL   string `json:"directory_url"`
	Email          string `json:"email"`
	Staging        bool   `json:"staging"`
}

type Metadata struct {
	Version     string    `json:"version"`
	LastUpdated time.Time `json:"last_updated"`
}

// NewState creates a new state instance
func NewState(filePath string) *State {
	return &State{
		Projects: make(map[string]*Project),
		LetsEncrypt: &LetsEncryptConfig{
			AccountKeyFile: "/var/lib/lightform-proxy/certs/account.key",
			DirectoryURL:   "https://acme-v02.api.letsencrypt.org/directory",
			Email:          "",
			Staging:        false,
		},
		Metadata: &Metadata{
			Version:     "2.0.0",
			LastUpdated: time.Now(),
		},
		filePath: filePath,
	}
}

// Load loads state from the JSON file
func (s *State) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			// File doesn't exist, use defaults
			return nil
		}
		return fmt.Errorf("failed to read state file: %w", err)
	}

	if err := json.Unmarshal(data, s); err != nil {
		return fmt.Errorf("failed to unmarshal state: %w", err)
	}

	// Ensure maps are initialized
	if s.Projects == nil {
		s.Projects = make(map[string]*Project)
	}

	for _, project := range s.Projects {
		if project.Hosts == nil {
			project.Hosts = make(map[string]*Host)
		}
	}

	return nil
}

// Save saves state to the JSON file
func (s *State) Save() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.modified {
		return nil
	}

	s.Metadata.LastUpdated = time.Now()

	// Ensure directory exists
	dir := filepath.Dir(s.filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create state directory: %w", err)
	}

	// Marshal to JSON
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal state: %w", err)
	}

	// Write atomically
	tmpFile := s.filePath + ".tmp"
	if err := os.WriteFile(tmpFile, data, 0644); err != nil {
		return fmt.Errorf("failed to write state file: %w", err)
	}

	if err := os.Rename(tmpFile, s.filePath); err != nil {
		return fmt.Errorf("failed to rename state file: %w", err)
	}

	s.modified = false
	return nil
}

// DeployHost adds or updates a host configuration
func (s *State) DeployHost(hostname, target, project, app, healthPath string, sslEnabled bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.Projects[project] == nil {
		s.Projects[project] = &Project{
			Hosts: make(map[string]*Host),
		}
	}

	host := &Host{
		Target:          target,
		App:             app,
		HealthPath:      healthPath,
		CreatedAt:       time.Now(),
		SSLEnabled:      sslEnabled,
		SSLRedirect:     sslEnabled,
		ForwardHeaders:  true,
		ResponseTimeout: "30s",
		Healthy:         true, // Assume healthy until health check proves otherwise
	}

	// If SSL is enabled, set up certificate status
	if sslEnabled {
		host.Certificate = &CertificateStatus{
			Status:      "pending",
			MaxAttempts: 144, // 24 hours of attempts every 10 minutes
		}
	}

	// Preserve existing certificate if updating
	if existing := s.Projects[project].Hosts[hostname]; existing != nil && existing.Certificate != nil {
		host.Certificate = existing.Certificate
	}

	s.Projects[project].Hosts[hostname] = host
	s.modified = true

	return nil
}

// RemoveHost removes a host configuration
func (s *State) RemoveHost(hostname string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for projectName, project := range s.Projects {
		if _, exists := project.Hosts[hostname]; exists {
			delete(project.Hosts, hostname)

			// Clean up empty projects
			if len(project.Hosts) == 0 {
				delete(s.Projects, projectName)
			}

			s.modified = true
			return nil
		}
	}

	return fmt.Errorf("host %s not found", hostname)
}

// GetHost returns the host configuration for a given hostname
func (s *State) GetHost(hostname string) (*Host, string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for projectName, project := range s.Projects {
		if host, exists := project.Hosts[hostname]; exists {
			return host, projectName, nil
		}
	}

	return nil, "", fmt.Errorf("host %s not found", hostname)
}

// GetAllHosts returns all hosts across all projects
func (s *State) GetAllHosts() map[string]*Host {
	s.mu.RLock()
	defer s.mu.RUnlock()

	hosts := make(map[string]*Host)
	for _, project := range s.Projects {
		for hostname, host := range project.Hosts {
			hosts[hostname] = host
		}
	}

	return hosts
}

// UpdateCertificateStatus updates the certificate status for a host
func (s *State) UpdateCertificateStatus(hostname string, status *CertificateStatus) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, project := range s.Projects {
		if host, exists := project.Hosts[hostname]; exists {
			host.Certificate = status
			s.modified = true
			return nil
		}
	}

	return fmt.Errorf("host %s not found", hostname)
}

// UpdateHealthStatus updates the health status for a host (runtime only)
func (s *State) UpdateHealthStatus(hostname string, healthy bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, project := range s.Projects {
		if host, exists := project.Hosts[hostname]; exists {
			host.Healthy = healthy
			host.LastHealthCheck = time.Now()
			// Note: We don't set modified=true because health is runtime-only
			return nil
		}
	}

	return fmt.Errorf("host %s not found", hostname)
}

// SetLetsEncryptStaging enables or disables Let's Encrypt staging mode
func (s *State) SetLetsEncryptStaging(enabled bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.LetsEncrypt.Staging = enabled
	if enabled {
		s.LetsEncrypt.DirectoryURL = "https://acme-staging-v02.api.letsencrypt.org/directory"
	} else {
		s.LetsEncrypt.DirectoryURL = "https://acme-v02.api.letsencrypt.org/directory"
	}

	s.modified = true
}

// SwitchTarget updates the target for a host (for blue-green deployments)
func (s *State) SwitchTarget(hostname, newTarget string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, project := range s.Projects {
		if host, exists := project.Hosts[hostname]; exists {
			host.Target = newTarget
			s.modified = true
			return nil
		}
	}

	return fmt.Errorf("host %s not found", hostname)
}

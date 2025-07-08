package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewState(t *testing.T) {
	filePath := "/tmp/test-state.json"
	state := NewState(filePath)

	assert.NotNil(t, state)
	assert.Equal(t, filePath, state.filePath)
	assert.NotNil(t, state.Projects)
	assert.NotNil(t, state.LetsEncrypt)
	assert.NotNil(t, state.Metadata)
	assert.Equal(t, "2.0.0", state.Metadata.Version)
	assert.False(t, state.LetsEncrypt.Staging)
	assert.Equal(t, "https://acme-v02.api.letsencrypt.org/directory", state.LetsEncrypt.DirectoryURL)
}

func TestStateLoadAndSave(t *testing.T) {
	// Create temporary file
	tmpDir := t.TempDir()
	filePath := filepath.Join(tmpDir, "state.json")

	// Test loading non-existent file (should not error)
	state := NewState(filePath)
	err := state.Load()
	assert.NoError(t, err)

	// Deploy a host to make state modified
	err = state.DeployHost("example.com", "app:3000", "testproject", "web", "/health", true)
	assert.NoError(t, err)

	// Save state
	err = state.Save()
	assert.NoError(t, err)

	// Verify file exists
	assert.FileExists(t, filePath)

	// Load state in new instance
	newState := NewState(filePath)
	err = newState.Load()
	assert.NoError(t, err)

	// Verify loaded state
	host, project, err := newState.GetHost("example.com")
	assert.NoError(t, err)
	assert.Equal(t, "testproject", project)
	assert.Equal(t, "app:3000", host.Target)
	assert.Equal(t, "web", host.App)
	assert.Equal(t, "/health", host.HealthPath)
	assert.True(t, host.SSLEnabled)
	assert.NotNil(t, host.Certificate)
	assert.Equal(t, "pending", host.Certificate.Status)
}

func TestStateLoadInvalidJSON(t *testing.T) {
	tmpDir := t.TempDir()
	filePath := filepath.Join(tmpDir, "invalid.json")

	// Write invalid JSON
	err := os.WriteFile(filePath, []byte("invalid json"), 0644)
	require.NoError(t, err)

	state := NewState(filePath)
	err = state.Load()
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "failed to unmarshal state")
}

func TestDeployHost(t *testing.T) {
	state := NewState("/tmp/test.json")

	// Test basic deployment
	err := state.DeployHost("test.example.com", "backend:8080", "myproject", "api", "/health", false)
	assert.NoError(t, err)

	host, project, err := state.GetHost("test.example.com")
	assert.NoError(t, err)
	assert.Equal(t, "myproject", project)
	assert.Equal(t, "backend:8080", host.Target)
	assert.Equal(t, "api", host.App)
	assert.Equal(t, "/health", host.HealthPath)
	assert.False(t, host.SSLEnabled)
	assert.Nil(t, host.Certificate)
	assert.True(t, host.Healthy)

	// Test SSL-enabled deployment
	err = state.DeployHost("ssl.example.com", "web:3000", "webapp", "frontend", "/api/health", true)
	assert.NoError(t, err)

	host, project, err = state.GetHost("ssl.example.com")
	assert.NoError(t, err)
	assert.Equal(t, "webapp", project)
	assert.True(t, host.SSLEnabled)
	assert.NotNil(t, host.Certificate)
	assert.Equal(t, "pending", host.Certificate.Status)
	assert.Equal(t, 144, host.Certificate.MaxAttempts)

	// Test updating existing host
	err = state.DeployHost("test.example.com", "newbackend:9000", "myproject", "api", "/healthz", true)
	assert.NoError(t, err)

	host, _, err = state.GetHost("test.example.com")
	assert.NoError(t, err)
	assert.Equal(t, "newbackend:9000", host.Target)
	assert.Equal(t, "/healthz", host.HealthPath)
	assert.True(t, host.SSLEnabled)
	assert.NotNil(t, host.Certificate)
}

func TestDeployHostPreserveCertificate(t *testing.T) {
	state := NewState("/tmp/test.json")

	// Deploy with SSL
	err := state.DeployHost("preserve.example.com", "app:3000", "project", "web", "/health", true)
	assert.NoError(t, err)

	// Update certificate status
	certStatus := &CertificateStatus{
		Status:     "active",
		AcquiredAt: time.Now(),
		ExpiresAt:  time.Now().Add(90 * 24 * time.Hour),
		CertFile:   "/certs/preserve.example.com/cert.pem",
		KeyFile:    "/certs/preserve.example.com/key.pem",
	}
	err = state.UpdateCertificateStatus("preserve.example.com", certStatus)
	assert.NoError(t, err)

	// Redeploy same host (should preserve certificate)
	err = state.DeployHost("preserve.example.com", "app:4000", "project", "web", "/health", true)
	assert.NoError(t, err)

	host, _, err := state.GetHost("preserve.example.com")
	assert.NoError(t, err)
	assert.Equal(t, "app:4000", host.Target)           // Updated
	assert.Equal(t, "active", host.Certificate.Status) // Preserved
	assert.Equal(t, "/certs/preserve.example.com/cert.pem", host.Certificate.CertFile)
}

func TestRemoveHost(t *testing.T) {
	state := NewState("/tmp/test.json")

	// Deploy multiple hosts
	err := state.DeployHost("host1.example.com", "app1:3000", "project1", "web", "/health", false)
	assert.NoError(t, err)
	err = state.DeployHost("host2.example.com", "app2:3000", "project1", "api", "/health", false)
	assert.NoError(t, err)
	err = state.DeployHost("host3.example.com", "app3:3000", "project2", "web", "/health", false)
	assert.NoError(t, err)

	// Remove host2
	err = state.RemoveHost("host2.example.com")
	assert.NoError(t, err)

	// Verify host2 is gone
	_, _, err = state.GetHost("host2.example.com")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "host2.example.com not found")

	// Verify other hosts still exist
	_, _, err = state.GetHost("host1.example.com")
	assert.NoError(t, err)
	_, _, err = state.GetHost("host3.example.com")
	assert.NoError(t, err)

	// Test removing non-existent host
	err = state.RemoveHost("nonexistent.example.com")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "nonexistent.example.com not found")
}

func TestGetAllHosts(t *testing.T) {
	state := NewState("/tmp/test.json")

	// Initially should be empty
	hosts := state.GetAllHosts()
	assert.Empty(t, hosts)

	// Deploy some hosts
	err := state.DeployHost("host1.example.com", "app1:3000", "project1", "web", "/health", false)
	assert.NoError(t, err)
	err = state.DeployHost("host2.example.com", "app2:3000", "project1", "api", "/health", true)
	assert.NoError(t, err)

	hosts = state.GetAllHosts()
	assert.Len(t, hosts, 2)
	assert.Contains(t, hosts, "host1.example.com")
	assert.Contains(t, hosts, "host2.example.com")
	assert.Equal(t, "app1:3000", hosts["host1.example.com"].Target)
	assert.Equal(t, "app2:3000", hosts["host2.example.com"].Target)
}

func TestUpdateCertificateStatus(t *testing.T) {
	state := NewState("/tmp/test.json")

	// Deploy host with SSL
	err := state.DeployHost("cert.example.com", "app:3000", "project", "web", "/health", true)
	assert.NoError(t, err)

	// Update certificate status
	certStatus := &CertificateStatus{
		Status:             "active",
		AcquiredAt:         time.Now(),
		ExpiresAt:          time.Now().Add(90 * 24 * time.Hour),
		LastRenewalAttempt: time.Now(),
		RenewalAttempts:    1,
		CertFile:           "/certs/cert.example.com/cert.pem",
		KeyFile:            "/certs/cert.example.com/key.pem",
		AttemptCount:       3,
	}

	err = state.UpdateCertificateStatus("cert.example.com", certStatus)
	assert.NoError(t, err)

	// Verify update
	host, _, err := state.GetHost("cert.example.com")
	assert.NoError(t, err)
	assert.Equal(t, "active", host.Certificate.Status)
	assert.Equal(t, 1, host.Certificate.RenewalAttempts)
	assert.Equal(t, 3, host.Certificate.AttemptCount)
	assert.Equal(t, "/certs/cert.example.com/cert.pem", host.Certificate.CertFile)

	// Test updating non-existent host
	err = state.UpdateCertificateStatus("nonexistent.example.com", certStatus)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "nonexistent.example.com not found")
}

func TestUpdateHealthStatus(t *testing.T) {
	state := NewState("/tmp/test.json")

	// Deploy host
	err := state.DeployHost("health.example.com", "app:3000", "project", "web", "/health", false)
	assert.NoError(t, err)

	// Initially healthy
	host, _, err := state.GetHost("health.example.com")
	assert.NoError(t, err)
	assert.True(t, host.Healthy)

	// Update to unhealthy
	err = state.UpdateHealthStatus("health.example.com", false)
	assert.NoError(t, err)

	host, _, err = state.GetHost("health.example.com")
	assert.NoError(t, err)
	assert.False(t, host.Healthy)
	assert.True(t, host.LastHealthCheck.After(time.Now().Add(-time.Second)))

	// Update back to healthy
	err = state.UpdateHealthStatus("health.example.com", true)
	assert.NoError(t, err)

	host, _, err = state.GetHost("health.example.com")
	assert.NoError(t, err)
	assert.True(t, host.Healthy)

	// Test updating non-existent host
	err = state.UpdateHealthStatus("nonexistent.example.com", true)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "nonexistent.example.com not found")
}

func TestSetLetsEncryptStaging(t *testing.T) {
	state := NewState("/tmp/test.json")

	// Initially production
	assert.False(t, state.LetsEncrypt.Staging)
	assert.Equal(t, "https://acme-v02.api.letsencrypt.org/directory", state.LetsEncrypt.DirectoryURL)

	// Set to staging
	state.SetLetsEncryptStaging(true)
	assert.True(t, state.LetsEncrypt.Staging)
	assert.Equal(t, "https://acme-staging-v02.api.letsencrypt.org/directory", state.LetsEncrypt.DirectoryURL)

	// Set back to production
	state.SetLetsEncryptStaging(false)
	assert.False(t, state.LetsEncrypt.Staging)
	assert.Equal(t, "https://acme-v02.api.letsencrypt.org/directory", state.LetsEncrypt.DirectoryURL)
}

func TestSwitchTarget(t *testing.T) {
	state := NewState("/tmp/test.json")

	// Deploy host
	err := state.DeployHost("switch.example.com", "old-app:3000", "project", "web", "/health", false)
	assert.NoError(t, err)

	// Switch target
	err = state.SwitchTarget("switch.example.com", "new-app:4000")
	assert.NoError(t, err)

	// Verify switch
	host, _, err := state.GetHost("switch.example.com")
	assert.NoError(t, err)
	assert.Equal(t, "new-app:4000", host.Target)

	// Test switching non-existent host
	err = state.SwitchTarget("nonexistent.example.com", "app:3000")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "nonexistent.example.com not found")
}

func TestStateConcurrency(t *testing.T) {
	state := NewState("/tmp/test.json")

	// Test concurrent operations
	done := make(chan bool, 10)

	for i := 0; i < 10; i++ {
		go func(index int) {
			hostname := fmt.Sprintf("concurrent%d.example.com", index)
			target := fmt.Sprintf("app%d:3000", index)

			err := state.DeployHost(hostname, target, "project", "web", "/health", false)
			assert.NoError(t, err)

			err = state.UpdateHealthStatus(hostname, false)
			assert.NoError(t, err)

			err = state.UpdateHealthStatus(hostname, true)
			assert.NoError(t, err)

			done <- true
		}(i)
	}

	// Wait for all goroutines
	for i := 0; i < 10; i++ {
		<-done
	}

	// Verify all hosts were created
	hosts := state.GetAllHosts()
	assert.Len(t, hosts, 10)
}

func TestStateJSONSerialization(t *testing.T) {
	state := NewState("/tmp/test.json")

	// Deploy complex configuration
	err := state.DeployHost("json.example.com", "app:3000", "project", "web", "/health", true)
	assert.NoError(t, err)

	// Update certificate status
	certStatus := &CertificateStatus{
		Status:             "active",
		AcquiredAt:         time.Now().Truncate(time.Second),
		ExpiresAt:          time.Now().Add(90 * 24 * time.Hour).Truncate(time.Second),
		LastRenewalAttempt: time.Now().Truncate(time.Second),
		RenewalAttempts:    2,
		CertFile:           "/certs/json.example.com/cert.pem",
		KeyFile:            "/certs/json.example.com/key.pem",
		FirstAttempt:       time.Now().Add(-time.Hour).Truncate(time.Second),
		LastAttempt:        time.Now().Add(-30 * time.Minute).Truncate(time.Second),
		NextAttempt:        time.Now().Add(time.Hour).Truncate(time.Second),
		AttemptCount:       5,
		MaxAttempts:        144,
	}
	err = state.UpdateCertificateStatus("json.example.com", certStatus)
	assert.NoError(t, err)

	// Set staging mode
	state.SetLetsEncryptStaging(true)

	// Marshal to JSON
	jsonData, err := json.MarshalIndent(state, "", "  ")
	assert.NoError(t, err)

	// Unmarshal to new state
	newState := &State{}
	err = json.Unmarshal(jsonData, newState)
	assert.NoError(t, err)

	// Verify structure
	assert.NotNil(t, newState.Projects)
	assert.NotNil(t, newState.LetsEncrypt)
	assert.NotNil(t, newState.Metadata)
	assert.True(t, newState.LetsEncrypt.Staging)

	// Verify host data
	project := newState.Projects["project"]
	assert.NotNil(t, project)
	host := project.Hosts["json.example.com"]
	assert.NotNil(t, host)
	assert.Equal(t, "app:3000", host.Target)
	assert.Equal(t, "web", host.App)
	assert.True(t, host.SSLEnabled)

	// Verify certificate data
	cert := host.Certificate
	assert.NotNil(t, cert)
	assert.Equal(t, "active", cert.Status)
	assert.Equal(t, 2, cert.RenewalAttempts)
	assert.Equal(t, 5, cert.AttemptCount)
	assert.Equal(t, "/certs/json.example.com/cert.pem", cert.CertFile)
}

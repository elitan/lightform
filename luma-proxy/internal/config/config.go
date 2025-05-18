package config

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
	"os"
	"path/filepath"
	"sync"

	"github.com/elitan/luma-proxy/pkg/models"
)

// ConfigFile is the path where the proxy configuration is stored
const ConfigFile = "/tmp/luma-proxy-config.json"

// ProxyConfig holds the global proxy configuration and services
type ProxyConfig struct {
	Services map[string]models.Service `json:"services"` // Map of service name to service config
	Certs    models.CertConfig         `json:"certs"`    // Certificate configuration
	mutex    sync.RWMutex              // Mutex to protect concurrent access
}

// New creates a new ProxyConfig instance
func New() *ProxyConfig {
	return &ProxyConfig{
		Services: make(map[string]models.Service),
		Certs:    models.NewDefaultCertConfig(),
	}
}

// Lock acquires a write lock on the config
func (c *ProxyConfig) Lock() {
	c.mutex.Lock()
}

// Unlock releases a write lock on the config
func (c *ProxyConfig) Unlock() {
	c.mutex.Unlock()
}

// RLock acquires a read lock on the config
func (c *ProxyConfig) RLock() {
	c.mutex.RLock()
}

// RUnlock releases a read lock on the config
func (c *ProxyConfig) RUnlock() {
	c.mutex.RUnlock()
}

// Load loads the proxy configuration from the config file
func (c *ProxyConfig) Load() {
	// Check if config file exists
	if _, err := os.Stat(ConfigFile); os.IsNotExist(err) {
		// Config file doesn't exist, use default empty config
		return
	}

	// Read the config file
	data, err := ioutil.ReadFile(ConfigFile)
	if err != nil {
		log.Printf("Warning: Failed to read config file: %v", err)
		return
	}

	// Unmarshal the config
	c.mutex.Lock()
	defer c.mutex.Unlock()
	if err := json.Unmarshal(data, c); err != nil {
		log.Printf("Warning: Failed to parse config file: %v", err)
		// Keep using the default empty config
	}
}

// Save saves the current proxy configuration to the config file
func (c *ProxyConfig) Save() error {
	c.mutex.RLock()
	defer c.mutex.RUnlock()

	// Marshal the config to JSON
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %v", err)
	}

	// Create directory if it doesn't exist
	dir := filepath.Dir(ConfigFile)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %v", err)
	}

	// Write the config file
	if err := ioutil.WriteFile(ConfigFile, data, 0644); err != nil {
		return fmt.Errorf("failed to write config file: %v", err)
	}

	return nil
}

package config

import (
	"os"
	"testing"
)

func TestDefaultConfig(t *testing.T) {
	config := DefaultConfig()
	
	// Test default values
	if config.ProxyServerPort != ":8080" {
		t.Errorf("Expected default ProxyServerPort to be ':8080', got '%s'", config.ProxyServerPort)
	}
	
	if config.APIServerPort != ":8081" {
		t.Errorf("Expected default APIServerPort to be ':8081', got '%s'", config.APIServerPort)
	}
	
	if config.InactivityTimeout != 20 {
		t.Errorf("Expected default InactivityTimeout to be 20, got %d", config.InactivityTimeout)
	}
	
	if config.CheckInterval != 3 {
		t.Errorf("Expected default CheckInterval to be 3, got %d", config.CheckInterval)
	}
	
	// Test Cloudflare defaults
	if config.Cloudflare.Enabled {
		t.Error("Expected Cloudflare.Enabled to be false by default")
	}
	
	if config.Cloudflare.AutoGenerate != true {
		t.Error("Expected Cloudflare.AutoGenerate to be true by default")
	}
}

func TestOverrideFromEnv(t *testing.T) {
	// Save original environment
	originalProxyPort := os.Getenv("LUMA_PROXY_PORT")
	originalAPIPort := os.Getenv("LUMA_API_PORT")
	originalInactivityTimeout := os.Getenv("LUMA_INACTIVITY_TIMEOUT")
	originalCheckInterval := os.Getenv("LUMA_CHECK_INTERVAL")
	originalServerAddress := os.Getenv("LUMA_SERVER_ADDRESS")
	originalCloudflareEnabled := os.Getenv("LUMA_CLOUDFLARE_ENABLED")
	originalCloudflareAPIToken := os.Getenv("LUMA_CLOUDFLARE_API_TOKEN")
	originalCloudflareZoneID := os.Getenv("LUMA_CLOUDFLARE_ZONE_ID")
	originalCloudflareBaseDomain := os.Getenv("LUMA_CLOUDFLARE_BASE_DOMAIN")
	originalCloudflareAutoGenerate := os.Getenv("LUMA_CLOUDFLARE_AUTO_GENERATE")
	
	// Restore environment after test
	defer func() {
		os.Setenv("LUMA_PROXY_PORT", originalProxyPort)
		os.Setenv("LUMA_API_PORT", originalAPIPort)
		os.Setenv("LUMA_INACTIVITY_TIMEOUT", originalInactivityTimeout)
		os.Setenv("LUMA_CHECK_INTERVAL", originalCheckInterval)
		os.Setenv("LUMA_SERVER_ADDRESS", originalServerAddress)
		os.Setenv("LUMA_CLOUDFLARE_ENABLED", originalCloudflareEnabled)
		os.Setenv("LUMA_CLOUDFLARE_API_TOKEN", originalCloudflareAPIToken)
		os.Setenv("LUMA_CLOUDFLARE_ZONE_ID", originalCloudflareZoneID)
		os.Setenv("LUMA_CLOUDFLARE_BASE_DOMAIN", originalCloudflareBaseDomain)
		os.Setenv("LUMA_CLOUDFLARE_AUTO_GENERATE", originalCloudflareAutoGenerate)
	}()
	
	// Set test environment variables
	os.Setenv("LUMA_PROXY_PORT", "9090")
	os.Setenv("LUMA_API_PORT", "9091")
	os.Setenv("LUMA_INACTIVITY_TIMEOUT", "30")
	os.Setenv("LUMA_CHECK_INTERVAL", "5")
	os.Setenv("LUMA_SERVER_ADDRESS", "test-server.com")
	os.Setenv("LUMA_CLOUDFLARE_ENABLED", "true")
	os.Setenv("LUMA_CLOUDFLARE_API_TOKEN", "test-token")
	os.Setenv("LUMA_CLOUDFLARE_ZONE_ID", "test-zone")
	os.Setenv("LUMA_CLOUDFLARE_BASE_DOMAIN", "test.com")
	os.Setenv("LUMA_CLOUDFLARE_AUTO_GENERATE", "false")
	
	// Get config from environment
	config := DefaultConfig()
	overrideFromEnv(&config)
	
	// Test values were overridden
	if config.ProxyServerPort != ":9090" {
		t.Errorf("Expected ProxyServerPort to be ':9090', got '%s'", config.ProxyServerPort)
	}
	
	if config.APIServerPort != ":9091" {
		t.Errorf("Expected APIServerPort to be ':9091', got '%s'", config.APIServerPort)
	}
	
	if config.InactivityTimeout != 30 {
		t.Errorf("Expected InactivityTimeout to be 30, got %d", config.InactivityTimeout)
	}
	
	if config.CheckInterval != 5 {
		t.Errorf("Expected CheckInterval to be 5, got %d", config.CheckInterval)
	}
	
	if config.ServerAddress != "test-server.com" {
		t.Errorf("Expected ServerAddress to be 'test-server.com', got '%s'", config.ServerAddress)
	}
	
	// Test Cloudflare values
	if !config.Cloudflare.Enabled {
		t.Error("Expected Cloudflare.Enabled to be true")
	}
	
	if config.Cloudflare.APIToken != "test-token" {
		t.Errorf("Expected Cloudflare.APIToken to be 'test-token', got '%s'", config.Cloudflare.APIToken)
	}
	
	if config.Cloudflare.ZoneID != "test-zone" {
		t.Errorf("Expected Cloudflare.ZoneID to be 'test-zone', got '%s'", config.Cloudflare.ZoneID)
	}
	
	if config.Cloudflare.BaseDomain != "test.com" {
		t.Errorf("Expected Cloudflare.BaseDomain to be 'test.com', got '%s'", config.Cloudflare.BaseDomain)
	}
	
	if config.Cloudflare.AutoGenerate {
		t.Error("Expected Cloudflare.AutoGenerate to be false")
	}
}

func TestEnsurePortFormat(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		// Already in correct format
		{":8080", ":8080"},
		{":80", ":80"},
		
		// Missing colon
		{"8080", ":8080"},
		{"80", ":80"},
		
		// With whitespace
		{" :8080 ", ":8080"},
		{" 8080 ", ":8080"},
	}
	
	for _, test := range tests {
		result := ensurePortFormat(test.input)
		if result != test.expected {
			t.Errorf("ensurePortFormat(%q) = %q, expected %q", test.input, result, test.expected)
		}
	}
}

func TestParseEnvInt(t *testing.T) {
	tests := []struct {
		input       string
		expected    int
		expectError bool
	}{
		// Valid integers
		{"10", 10, false},
		{"0", 0, false},
		{"-5", -5, false},
		
		// Invalid values
		{"abc", 0, true},
		{"10.5", 0, true},
		{"", 0, true},
	}
	
	for _, test := range tests {
		result, err := parseEnvInt(test.input)
		
		if test.expectError && err == nil {
			t.Errorf("parseEnvInt(%q) expected error, got nil", test.input)
		}
		
		if !test.expectError && err != nil {
			t.Errorf("parseEnvInt(%q) unexpected error: %v", test.input, err)
		}
		
		if result != test.expected {
			t.Errorf("parseEnvInt(%q) = %d, expected %d", test.input, result, test.expected)
		}
	}
}
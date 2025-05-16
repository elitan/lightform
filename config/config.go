package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"luma/types"
)

// Config holds the application configuration
type Config struct {
	ProxyServerPort   string                `json:"proxy_server_port"`
	APIServerPort     string                `json:"api_server_port"`
	InactivityTimeout int                   `json:"inactivity_timeout"`
	CheckInterval     int                   `json:"check_interval"`
	ServerAddress     string                `json:"server_address"`
	Cloudflare        types.CloudflareConfig `json:"cloudflare"`
}

// DefaultConfig returns the default configuration
func DefaultConfig() Config {
	return Config{
		ProxyServerPort:   ":8080",
		APIServerPort:     ":8081",
		InactivityTimeout: 20,  // 20 seconds
		CheckInterval:     3,    // 3 seconds
		ServerAddress:     "localhost",
		Cloudflare: types.CloudflareConfig{
			Enabled:      false,
			APIToken:     "",
			ZoneID:       "",
			BaseDomain:   "",
			AutoGenerate: true,
		},
	}
}

// LoadConfig loads configuration from a file or environment variables
func LoadConfig(configPath string) (Config, error) {
	config := DefaultConfig()

	// Load from file if provided
	if configPath != "" {
		if err := loadFromFile(&config, configPath); err != nil {
			return config, err
		}
	}

	// Override with environment variables
	overrideFromEnv(&config)

	return config, nil
}

// loadFromFile loads configuration from a JSON file
func loadFromFile(config *Config, path string) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("failed to open config file: %w", err)
	}
	defer file.Close()

	bytes, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("failed to read config file: %w", err)
	}

	if err := json.Unmarshal(bytes, config); err != nil {
		return fmt.Errorf("failed to parse config file: %w", err)
	}

	return nil
}

// overrideFromEnv overrides configuration with environment variables
func overrideFromEnv(config *Config) {
	// Core settings
	if val := os.Getenv("LUMA_PROXY_PORT"); val != "" {
		config.ProxyServerPort = ensurePortFormat(val)
	}
	
	if val := os.Getenv("LUMA_API_PORT"); val != "" {
		config.APIServerPort = ensurePortFormat(val)
	}
	
	if val := os.Getenv("LUMA_INACTIVITY_TIMEOUT"); val != "" {
		if timeout, err := parseEnvInt(val); err == nil {
			config.InactivityTimeout = timeout
		}
	}
	
	if val := os.Getenv("LUMA_CHECK_INTERVAL"); val != "" {
		if interval, err := parseEnvInt(val); err == nil {
			config.CheckInterval = interval
		}
	}
	
	if val := os.Getenv("LUMA_SERVER_ADDRESS"); val != "" {
		config.ServerAddress = val
	}

	// Cloudflare settings
	if val := os.Getenv("LUMA_CLOUDFLARE_ENABLED"); val != "" {
		config.Cloudflare.Enabled = strings.ToLower(val) == "true"
	}
	
	if val := os.Getenv("LUMA_CLOUDFLARE_API_TOKEN"); val != "" {
		config.Cloudflare.APIToken = val
	}
	
	if val := os.Getenv("LUMA_CLOUDFLARE_ZONE_ID"); val != "" {
		config.Cloudflare.ZoneID = val
	}
	
	if val := os.Getenv("LUMA_CLOUDFLARE_BASE_DOMAIN"); val != "" {
		config.Cloudflare.BaseDomain = val
	}
	
	if val := os.Getenv("LUMA_CLOUDFLARE_AUTO_GENERATE"); val != "" {
		config.Cloudflare.AutoGenerate = strings.ToLower(val) == "true"
	}
}

// ensurePortFormat ensures port is in the format ":8080"
func ensurePortFormat(port string) string {
	port = strings.TrimSpace(port)
	if !strings.HasPrefix(port, ":") {
		return ":" + port
	}
	return port
}

// parseEnvInt parses an integer from an environment variable
func parseEnvInt(val string) (int, error) {
	var result int
	if _, err := fmt.Sscanf(val, "%d", &result); err != nil {
		return 0, err
	}
	return result, nil
}
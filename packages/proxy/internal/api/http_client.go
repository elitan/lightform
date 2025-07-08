package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// HTTPClient provides HTTP API client for CLI commands
type HTTPClient struct {
	baseURL    string
	httpClient *http.Client
}

// NewHTTPClient creates a new HTTP API client
func NewHTTPClient(baseURL string) *HTTPClient {
	if baseURL == "" {
		baseURL = "http://localhost:8080"
	}

	return &HTTPClient{
		baseURL:    baseURL,
		httpClient: &http.Client{},
	}
}

// Deploy deploys a host via HTTP API
func (c *HTTPClient) Deploy(host, target, project, app, healthPath string, ssl bool) error {
	req := HTTPDeployRequest{
		Host:       host,
		Target:     target,
		Project:    project,
		App:        app,
		HealthPath: healthPath,
		SSL:        ssl,
	}

	resp, err := c.makeRequest("POST", "/api/deploy", req)
	if err != nil {
		return err
	}

	if resp.Success {
		fmt.Printf("✅ %s\n", resp.Message)
	} else {
		return fmt.Errorf("deployment failed: %s", resp.Message)
	}

	return nil
}

// Remove removes a host via HTTP API
func (c *HTTPClient) Remove(host string) error {
	resp, err := c.makeRequest("DELETE", fmt.Sprintf("/api/hosts/%s", host), nil)
	if err != nil {
		return err
	}

	if resp.Success {
		fmt.Printf("✅ %s\n", resp.Message)
	} else {
		return fmt.Errorf("removal failed: %s", resp.Message)
	}

	return nil
}

// List lists all hosts via HTTP API
func (c *HTTPClient) List() error {
	resp, err := c.makeRequest("GET", "/api/hosts", nil)
	if err != nil {
		return err
	}

	if !resp.Success {
		return fmt.Errorf("failed to list hosts: %s", resp.Message)
	}

	// Pretty print the hosts data
	if hostsData, ok := resp.Data.(map[string]interface{}); ok {
		if len(hostsData) == 0 {
			fmt.Println("No hosts configured")
			return nil
		}

		fmt.Println("Configured hosts:")
		for hostname, hostInfo := range hostsData {
			if hostMap, ok := hostInfo.(map[string]interface{}); ok {
				target := hostMap["target"]
				ssl := hostMap["ssl_enabled"]
				healthy := hostMap["healthy"]

				fmt.Printf("  %s -> %s (SSL: %v, Healthy: %v)\n", hostname, target, ssl, healthy)

				// Show certificate status if available
				if cert, exists := hostMap["certificate"]; exists && cert != nil {
					if certMap, ok := cert.(map[string]interface{}); ok {
						if status, exists := certMap["status"]; exists {
							fmt.Printf("    Certificate: %s\n", status)
						}
					}
				}
			}
		}
	} else {
		// Fallback to raw JSON output
		jsonData, _ := json.MarshalIndent(resp.Data, "", "  ")
		fmt.Println(string(jsonData))
	}

	return nil
}

// UpdateHealth updates host health status via HTTP API
func (c *HTTPClient) UpdateHealth(host string, healthy bool) error {
	req := HealthUpdateRequest{
		Healthy: healthy,
	}

	resp, err := c.makeRequest("PUT", fmt.Sprintf("/api/hosts/%s/health", host), req)
	if err != nil {
		return err
	}

	if resp.Success {
		fmt.Printf("✅ %s\n", resp.Message)
	} else {
		return fmt.Errorf("health update failed: %s", resp.Message)
	}

	return nil
}

// CertRenew renews certificate via HTTP API
func (c *HTTPClient) CertRenew(host string) error {
	resp, err := c.makeRequest("POST", fmt.Sprintf("/api/cert/renew/%s", host), nil)
	if err != nil {
		return err
	}

	if resp.Success {
		fmt.Printf("✅ %s\n", resp.Message)
	} else {
		return fmt.Errorf("certificate renewal failed: %s", resp.Message)
	}

	return nil
}

// CertStatus gets certificate status via HTTP API
func (c *HTTPClient) CertStatus(host string) error {
	endpoint := "/api/status"
	if host != "" {
		endpoint += "?host=" + url.QueryEscape(host)
	}

	resp, err := c.makeRequest("GET", endpoint, nil)
	if err != nil {
		return err
	}

	if !resp.Success {
		return fmt.Errorf("failed to get certificate status: %s", resp.Message)
	}

	// Pretty print certificate status
	if host != "" {
		// Single host certificate status
		if resp.Data != nil {
			fmt.Printf("Certificate status for %s:\n", host)
			jsonData, _ := json.MarshalIndent(resp.Data, "", "  ")
			fmt.Println(string(jsonData))
		} else {
			fmt.Printf("No certificate information for %s\n", host)
		}
	} else {
		// All hosts certificate status
		if certData, ok := resp.Data.(map[string]interface{}); ok {
			if len(certData) == 0 {
				fmt.Println("No certificate information available")
				return nil
			}

			fmt.Println("Certificate status for all hosts:")
			for hostname, certInfo := range certData {
				fmt.Printf("\n%s:\n", hostname)
				if certInfo != nil {
					jsonData, _ := json.MarshalIndent(certInfo, "", "  ")
					fmt.Println(string(jsonData))
				} else {
					fmt.Println("  No certificate")
				}
			}
		} else {
			// Fallback to raw JSON output
			jsonData, _ := json.MarshalIndent(resp.Data, "", "  ")
			fmt.Println(string(jsonData))
		}
	}

	return nil
}

// SetStaging sets Let's Encrypt staging mode via HTTP API
func (c *HTTPClient) SetStaging(enabled bool) error {
	req := StagingRequest{
		Enabled: enabled,
	}

	resp, err := c.makeRequest("PUT", "/api/staging", req)
	if err != nil {
		return err
	}

	if resp.Success {
		fmt.Printf("✅ %s\n", resp.Message)
	} else {
		return fmt.Errorf("staging mode update failed: %s", resp.Message)
	}

	return nil
}

// SwitchTarget switches host target via HTTP API
func (c *HTTPClient) SwitchTarget(host, target string) error {
	// Note: This endpoint isn't in the PDR, but exists in the Unix socket API
	// We'll implement it as a PATCH to /api/hosts/:host for consistency
	req := map[string]string{
		"target": target,
	}

	resp, err := c.makeRequest("PATCH", fmt.Sprintf("/api/hosts/%s", host), req)
	if err != nil {
		return err
	}

	if resp.Success {
		fmt.Printf("✅ %s\n", resp.Message)
	} else {
		return fmt.Errorf("target switch failed: %s", resp.Message)
	}

	return nil
}

// makeRequest makes an HTTP request to the API server
func (c *HTTPClient) makeRequest(method, endpoint string, payload interface{}) (*HTTPResponse, error) {
	url := c.baseURL + endpoint

	var body io.Reader
	if payload != nil {
		jsonData, err := json.Marshal(payload)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request: %w", err)
		}
		body = bytes.NewBuffer(jsonData)
	}

	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to make request: %w", err)
	}
	defer resp.Body.Close()

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var apiResp HTTPResponse
	if err := json.Unmarshal(responseBody, &apiResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	return &apiResp, nil
}

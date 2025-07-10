package services

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// HealthService provides health checking functionality
type HealthService struct {
	client *http.Client
}

// NewHealthService creates a new health service
func NewHealthService() *HealthService {
	return &HealthService{
		client: &http.Client{
			Timeout: 5 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        10,
				MaxIdleConnsPerHost: 2,
				IdleConnTimeout:     30 * time.Second,
			},
		},
	}
}

// CheckHealth performs a health check against the given target and path
func (h *HealthService) CheckHealth(ctx context.Context, target, healthPath string) error {
	url := fmt.Sprintf("http://%s%s", target, healthPath)
	
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("health check request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("health check failed with status %d", resp.StatusCode)
	}

	return nil
}
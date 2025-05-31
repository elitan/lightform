package service

import (
	"fmt"
	"os"
	"testing"

	"github.com/elitan/luma-proxy/internal/config"
	"github.com/elitan/luma-proxy/pkg/models"
)

func TestFindByHost(t *testing.T) {
	// Remove any existing config file that might interfere with tests
	os.Remove("/tmp/luma-proxy-config.json")

	// Create test configuration
	cfg := &config.ProxyConfig{
		Services: make(map[string]models.Service),
	}

	// Add test services before creating the manager
	testServices := []models.Service{
		{
			Name:       "test-project-a.local",
			Host:       "test-project-a.local",
			Target:     "web:3000",
			Project:    "project-a",
			Healthy:    true,
			HealthPath: "/api/health",
		},
		{
			Name:       "test-project-b.local",
			Host:       "test-project-b.local",
			Target:     "web:3000",
			Project:    "project-b",
			Healthy:    true,
			HealthPath: "/api/health",
		},
	}

	for _, service := range testServices {
		cfg.Services[service.Host] = service
	}

	// Create service manager with pre-populated config
	manager := NewManager(cfg)

	// Debug: Check if services are in the config
	t.Logf("Services in config: %d", len(cfg.Services))
	for host, service := range cfg.Services {
		t.Logf("Service: %s -> %s (project: %s)", host, service.Target, service.Project)
	}

	// Test finding existing service
	service, found := manager.FindByHost("test-project-a.local")
	if !found {
		t.Error("Expected to find service for test-project-a.local")
		return
	}
	if service.Project != "project-a" {
		t.Errorf("Expected project 'project-a', got '%s'", service.Project)
	}
	if service.Target != "web:3000" {
		t.Errorf("Expected target 'web:3000', got '%s'", service.Target)
	}

	// Test finding non-existing service
	_, found = manager.FindByHost("nonexistent.local")
	if found {
		t.Error("Expected not to find service for nonexistent.local")
	}
}

func TestDeployWithHealthPath(t *testing.T) {
	// Create test configuration
	cfg := &config.ProxyConfig{
		Services: make(map[string]models.Service),
	}

	// Create service manager
	manager := NewManager(cfg)

	// Test deploying new service
	err := manager.DeployWithHealthPath("test.local", "web:3000", "test-project", "/api/health")
	if err != nil {
		t.Errorf("Expected no error, got %v", err)
	}

	// Verify service was added
	service, found := manager.FindByHost("test.local")
	if !found {
		t.Error("Expected to find deployed service")
	}
	if service.Target != "web:3000" {
		t.Errorf("Expected target 'web:3000', got '%s'", service.Target)
	}
	if service.Project != "test-project" {
		t.Errorf("Expected project 'test-project', got '%s'", service.Project)
	}
	if service.HealthPath != "/api/health" {
		t.Errorf("Expected health path '/api/health', got '%s'", service.HealthPath)
	}
}

func TestDeployConflict(t *testing.T) {
	// Create test configuration
	cfg := &config.ProxyConfig{
		Services: make(map[string]models.Service),
	}

	// Create service manager
	manager := NewManager(cfg)

	// Deploy first service
	err := manager.DeployWithHealthPath("test.local", "web:3000", "project-a", "/api/health")
	if err != nil {
		t.Errorf("Expected no error for first deployment, got %v", err)
	}

	// Try to deploy same host in different project (should fail)
	err = manager.DeployWithHealthPath("test.local", "web:3000", "project-b", "/api/health")
	if err == nil {
		t.Error("Expected error when deploying same host to different project")
	}

	// Deploy same host in same project (should succeed)
	err = manager.DeployWithHealthPath("test.local", "web:4000", "project-a", "/api/health")
	if err != nil {
		t.Errorf("Expected no error when updating same host in same project, got %v", err)
	}

	// Verify the service was updated
	service, found := manager.FindByHost("test.local")
	if !found {
		t.Error("Expected to find updated service")
	}
	if service.Target != "web:4000" {
		t.Errorf("Expected updated target 'web:4000', got '%s'", service.Target)
	}
}

func TestUpdateServiceHealth(t *testing.T) {
	// Create test configuration
	cfg := &config.ProxyConfig{
		Services: make(map[string]models.Service),
	}

	// Create service manager
	manager := NewManager(cfg)

	// Deploy test service
	err := manager.DeployWithHealthPath("test.local", "web:3000", "test-project", "/api/health")
	if err != nil {
		t.Errorf("Expected no error, got %v", err)
	}

	// Update health status
	err = manager.UpdateServiceHealth("test.local", false)
	if err != nil {
		t.Errorf("Expected no error updating health, got %v", err)
	}

	// Verify health was updated
	service, found := manager.FindByHost("test.local")
	if !found {
		t.Error("Expected to find service")
	}
	if service.Healthy {
		t.Error("Expected service to be unhealthy")
	}

	// Test updating non-existent service
	err = manager.UpdateServiceHealth("nonexistent.local", true)
	if err == nil {
		t.Error("Expected error when updating non-existent service")
	}
}

func TestGetAllServices(t *testing.T) {
	// Create test configuration
	cfg := &config.ProxyConfig{
		Services: make(map[string]models.Service),
	}

	// Create service manager
	manager := NewManager(cfg)

	// Deploy multiple services
	services := []struct {
		host    string
		target  string
		project string
	}{
		{"test-a.local", "web:3000", "project-a"},
		{"test-b.local", "web:3000", "project-b"},
		{"api.local", "api:8080", "project-a"},
	}

	for _, svc := range services {
		err := manager.DeployWithHealthPath(svc.host, svc.target, svc.project, "/api/health")
		if err != nil {
			t.Errorf("Expected no error deploying %s, got %v", svc.host, err)
		}
	}

	// Get all services
	allServices := manager.GetAllServices()
	if len(allServices) != 3 {
		t.Errorf("Expected 3 services, got %d", len(allServices))
	}

	// Verify services are returned correctly
	hostMap := make(map[string]models.Service)
	for _, service := range allServices {
		hostMap[service.Host] = service
	}

	for _, expected := range services {
		service, found := hostMap[expected.host]
		if !found {
			t.Errorf("Expected to find service for %s", expected.host)
			continue
		}
		if service.Target != expected.target {
			t.Errorf("Expected target %s for %s, got %s", expected.target, expected.host, service.Target)
		}
		if service.Project != expected.project {
			t.Errorf("Expected project %s for %s, got %s", expected.project, expected.host, service.Project)
		}
	}
}

func TestMultiProjectIsolation(t *testing.T) {
	// Create test configuration
	cfg := &config.ProxyConfig{
		Services: make(map[string]models.Service),
	}

	// Create service manager
	manager := NewManager(cfg)

	// Deploy same service name in different projects
	err := manager.DeployWithHealthPath("app-a.local", "web:3000", "project-a", "/api/health")
	if err != nil {
		t.Errorf("Expected no error deploying to project-a, got %v", err)
	}

	err = manager.DeployWithHealthPath("app-b.local", "web:3000", "project-b", "/api/health")
	if err != nil {
		t.Errorf("Expected no error deploying to project-b, got %v", err)
	}

	// Verify both services exist with same target but different projects
	serviceA, foundA := manager.FindByHost("app-a.local")
	serviceB, foundB := manager.FindByHost("app-b.local")

	if !foundA || !foundB {
		t.Error("Expected to find both services")
	}

	if serviceA.Target != "web:3000" || serviceB.Target != "web:3000" {
		t.Error("Expected both services to have target 'web:3000'")
	}

	if serviceA.Project == serviceB.Project {
		t.Error("Expected services to be in different projects")
	}

	if serviceA.Project != "project-a" {
		t.Errorf("Expected service A in 'project-a', got '%s'", serviceA.Project)
	}

	if serviceB.Project != "project-b" {
		t.Errorf("Expected service B in 'project-b', got '%s'", serviceB.Project)
	}
}

// Benchmark tests
func BenchmarkFindByHost(b *testing.B) {
	cfg := &config.ProxyConfig{
		Services: make(map[string]models.Service),
	}
	manager := NewManager(cfg)

	// Add multiple services
	for i := 0; i < 100; i++ {
		host := fmt.Sprintf("test-%d.local", i)
		err := manager.DeployWithHealthPath(host, "web:3000", "test-project", "/api/health")
		if err != nil {
			b.Fatalf("Failed to deploy service: %v", err)
		}
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = manager.FindByHost("test-50.local")
	}
}

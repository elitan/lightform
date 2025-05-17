package cloudflare

import (
	"context"
	"testing"

	"luma/types"
)

func TestNewManager(t *testing.T) {
	// Test with nil client
	manager := NewManager(nil, false)
	if manager.enabled {
		t.Error("Manager should be disabled with nil client")
	}

	// Test with client and auto-generate
	config := types.CloudflareConfig{
		Enabled:    false,
		BaseDomain: "example.com",
	}
	client, _ := NewClient(config, "test-server.com")
	
	manager = NewManager(client, true)
	if !manager.enabled {
		t.Error("Manager should be enabled with client")
	}
	if !manager.autoGen {
		t.Error("Manager should have autoGen=true")
	}
}

func TestRegisterProjectDomain_Disabled(t *testing.T) {
	// Test with disabled manager
	manager := NewManager(nil, false)
	
	project := types.Project{
		Name:        "test-project",
		DockerImage: "nginx",
		Hostname:    "test.localhost",
	}
	
	domain, err := manager.RegisterProjectDomain(context.Background(), project)
	if err != nil {
		t.Fatalf("RegisterProjectDomain failed with disabled manager: %v", err)
	}
	
	if domain != nil {
		t.Error("Expected domain to be nil with disabled manager")
	}
}

func TestRegisterProjectDomain_NoAutoGen(t *testing.T) {
	// Test with enabled manager but autoGen disabled
	config := types.CloudflareConfig{
		Enabled:    false,
		BaseDomain: "example.com",
	}
	client, _ := NewClient(config, "test-server.com")
	
	manager := NewManager(client, false) // autoGen = false
	
	project := types.Project{
		Name:        "test-project",
		DockerImage: "nginx",
		Hostname:    "test.localhost",
	}
	
	domain, err := manager.RegisterProjectDomain(context.Background(), project)
	if err != nil {
		t.Fatalf("RegisterProjectDomain failed with autoGen disabled: %v", err)
	}
	
	if domain != nil {
		t.Error("Expected domain to be nil with autoGen disabled")
	}
}

func TestRegisterProjectDomain(t *testing.T) {
	// Test with enabled manager and autoGen
	config := types.CloudflareConfig{
		Enabled:    false,
		BaseDomain: "example.com",
	}
	client, _ := NewClient(config, "test-server.com")
	
	manager := NewManager(client, true) // autoGen = true
	
	project := types.Project{
		Name:        "test-project",
		DockerImage: "nginx",
		Hostname:    "test.localhost",
	}
	
	// First registration
	domain, err := manager.RegisterProjectDomain(context.Background(), project)
	if err != nil {
		t.Fatalf("RegisterProjectDomain failed: %v", err)
	}
	
	if domain == nil {
		t.Fatal("Expected domain to be returned")
	}
	
	// Second registration (should return cached domain)
	domain2, err := manager.RegisterProjectDomain(context.Background(), project)
	if err != nil {
		t.Fatalf("Second RegisterProjectDomain failed: %v", err)
	}
	
	if domain2 == nil {
		t.Fatal("Expected domain to be returned from second call")
	}
	
	if domain.Domain != domain2.Domain {
		t.Errorf("Expected same domain from both calls, got %q and %q", domain.Domain, domain2.Domain)
	}
}

func TestDeleteProjectDomain(t *testing.T) {
	// Test with enabled manager
	config := types.CloudflareConfig{
		Enabled:    false,
		BaseDomain: "example.com",
	}
	client, _ := NewClient(config, "test-server.com")
	
	manager := NewManager(client, true)
	
	project := types.Project{
		Name:        "test-project",
		DockerImage: "nginx",
		Hostname:    "test.localhost",
	}
	
	// Register domain first
	_, err := manager.RegisterProjectDomain(context.Background(), project)
	if err != nil {
		t.Fatalf("RegisterProjectDomain failed: %v", err)
	}
	
	// Now delete it
	err = manager.DeleteProjectDomain(context.Background(), project.Hostname)
	if err != nil {
		t.Fatalf("DeleteProjectDomain failed: %v", err)
	}
	
	// Check it's gone
	_, exists := manager.GetProjectDomain(project.Hostname)
	if exists {
		t.Error("Domain still exists after deletion")
	}
}

func TestGetAllDomains_Empty(t *testing.T) {
	manager := NewManager(nil, false)
	
	domains := manager.GetAllDomains()
	if len(domains) != 0 {
		t.Errorf("Expected empty domains list, got %d domains", len(domains))
	}
}

func TestGetAllDomains_Manager(t *testing.T) {
	config := types.CloudflareConfig{
		Enabled:    false,
		BaseDomain: "example.com",
	}
	client, _ := NewClient(config, "test-server.com")
	
	manager := NewManager(client, true)
	
	// Create a few domains
	projects := []types.Project{
		{Name: "project1", Hostname: "proj1.localhost"},
		{Name: "project2", Hostname: "proj2.localhost"},
		{Name: "project3", Hostname: "proj3.localhost"},
	}
	
	for _, project := range projects {
		_, _ = manager.RegisterProjectDomain(context.Background(), project)
	}
	
	domains := manager.GetAllDomains()
	if len(domains) != len(projects) {
		t.Errorf("Expected %d domains, got %d", len(projects), len(domains))
	}
}
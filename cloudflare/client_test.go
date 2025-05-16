package cloudflare

import (
	"context"
	"testing"

	"luma/types"
)

func TestNewClient(t *testing.T) {
	// Test with Cloudflare disabled
	config := types.CloudflareConfig{
		Enabled:    false,
		APIToken:   "fake-token",
		ZoneID:     "fake-zone",
		BaseDomain: "example.com",
	}

	client, err := NewClient(config, "test-server.com")
	if err != nil {
		t.Fatalf("Failed to create client with Cloudflare disabled: %v", err)
	}

	if client.api != nil {
		t.Error("Expected API client to be nil when Cloudflare is disabled")
	}

	// Test with invalid configuration (should not fail with disabled flag)
	config = types.CloudflareConfig{
		Enabled:    false,
		APIToken:   "", // Missing token
		ZoneID:     "",
		BaseDomain: "",
	}

	client, err = NewClient(config, "test-server.com")
	if err != nil {
		t.Fatalf("Failed to create client with disabled Cloudflare and invalid config: %v", err)
	}
}

func TestSanitizeForDNS(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		// Basic cases
		{"simple", "simple"},
		{"simple-test", "simple-test"},
		
		// Special characters
		{"test_project", "test-project"},
		{"test.project", "test-project"},
		{"test/project", "test-project"},
		{"test project", "test-project"},
		
		// Mixed case
		{"TestProject", "testproject"},
		{"TEST_PROJECT", "test-project"},
		
		// Starting/ending with special chars
		{"-test-", "test"},
		{"_test_", "test"},
		{" test ", "test"},
		
		// Multiple special chars
		{"test__project", "test-project"},
		{"test--project", "test-project"},
		{"test  project", "test-project"},
		
		// Empty string
		{"", "app"},
		
		// Only special chars
		{"---", "app"},
		{"   ", "app"},
		{"___", "app"},
	}

	for _, test := range tests {
		result := sanitizeForDNS(test.input)
		if result != test.expected {
			t.Errorf("sanitizeForDNS(%q) = %q, expected %q", test.input, result, test.expected)
		}
	}
}

func TestCreateDomain_Disabled(t *testing.T) {
	// Test with Cloudflare disabled
	config := types.CloudflareConfig{
		Enabled:    false,
		BaseDomain: "example.com",
	}

	client, _ := NewClient(config, "test-server.com")
	
	project := types.Project{
		Name:        "test-project",
		DockerImage: "nginx",
		Hostname:    "test.localhost",
	}
	
	domain, err := client.CreateDomain(context.Background(), project)
	if err != nil {
		t.Fatalf("CreateDomain failed with disabled Cloudflare: %v", err)
	}
	
	if domain == nil {
		t.Fatal("Expected domain to be returned even with Cloudflare disabled")
	}
	
	if domain.Domain != "test-project.example.com" {
		t.Errorf("Expected domain to be 'test-project.example.com', got %q", domain.Domain)
	}
	
	// Domain should be stored in the map
	if _, exists := client.GetDomain("test.localhost"); !exists {
		t.Error("Domain was not stored in the client's map")
	}
}

func TestDeleteDomain_Disabled(t *testing.T) {
	// Test with Cloudflare disabled
	config := types.CloudflareConfig{
		Enabled:    false,
		BaseDomain: "example.com",
	}

	client, _ := NewClient(config, "test-server.com")
	
	// First create a domain
	project := types.Project{
		Name:        "test-project",
		DockerImage: "nginx",
		Hostname:    "test.localhost",
	}
	
	_, _ = client.CreateDomain(context.Background(), project)
	
	// Now delete it
	err := client.DeleteDomain(context.Background(), "test.localhost")
	if err != nil {
		t.Fatalf("DeleteDomain failed with disabled Cloudflare: %v", err)
	}
	
	// Domain should be removed from the map
	if _, exists := client.GetDomain("test.localhost"); exists {
		t.Error("Domain was not removed from the client's map")
	}
}

func TestGetAllDomains(t *testing.T) {
	config := types.CloudflareConfig{
		Enabled:    false,
		BaseDomain: "example.com",
	}

	client, _ := NewClient(config, "test-server.com")
	
	// Create a few domains
	projects := []types.Project{
		{Name: "project1", Hostname: "proj1.localhost"},
		{Name: "project2", Hostname: "proj2.localhost"},
		{Name: "project3", Hostname: "proj3.localhost"},
	}
	
	for _, project := range projects {
		_, _ = client.CreateDomain(context.Background(), project)
	}
	
	domains := client.GetAllDomains()
	if len(domains) != len(projects) {
		t.Errorf("Expected %d domains, got %d", len(projects), len(domains))
	}
}
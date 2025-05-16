package cloudflare

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"

	cf "github.com/cloudflare/cloudflare-go"
	"luma/types"
)

// Client handles interactions with Cloudflare API
type Client struct {
	api        *cf.API
	config     types.CloudflareConfig
	domainMap  map[string]types.ProjectDomain // Maps project hostname to domain info
	mu         sync.RWMutex
	serverAddr string // The server's public IP or hostname
}

// NewClient creates a new Cloudflare API client
func NewClient(config types.CloudflareConfig, serverAddr string) (*Client, error) {
	if !config.Enabled {
		return &Client{
			config:     config,
			domainMap:  make(map[string]types.ProjectDomain),
			serverAddr: serverAddr,
		}, nil
	}

	api, err := cf.NewWithAPIToken(config.APIToken)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize Cloudflare API client: %w", err)
	}

	return &Client{
		api:        api,
		config:     config,
		domainMap:  make(map[string]types.ProjectDomain),
		serverAddr: serverAddr,
	}, nil
}

// CreateDomain creates a subdomain for a project
func (c *Client) CreateDomain(ctx context.Context, project types.Project) (*types.ProjectDomain, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// If not enabled, just return mock data
	if !c.config.Enabled {
		log.Printf("Cloudflare: Integration disabled. Would create domain for project '%s'", project.Name)
		mockDomain := &types.ProjectDomain{
			ProjectHostname: project.Hostname,
			Domain:          project.Name + "." + c.config.BaseDomain,
		}
		c.domainMap[project.Hostname] = *mockDomain
		return mockDomain, nil
	}

	// Generate subdomain name (sanitize project name for DNS)
	subdomain := sanitizeForDNS(project.Name)
	fullDomain := fmt.Sprintf("%s.%s", subdomain, c.config.BaseDomain)

	// Create DNS record via Cloudflare API
	proxied := true
	recordParams := cf.CreateDNSRecordParams{
		Type:    "A", // Using A record, could also support CNAME
		Name:    subdomain,
		Content: c.serverAddr,
		TTL:     120, // 2 minutes for testing, adjust for production
		Proxied: &proxied,
	}

	log.Printf("Cloudflare: Creating DNS record for %s -> %s", fullDomain, c.serverAddr)

	record, err := c.api.CreateDNSRecord(ctx, cf.ZoneIdentifier(c.config.ZoneID), recordParams)
	if err != nil {
		return nil, fmt.Errorf("failed to create DNS record: %w", err)
	}

	// Store the domain mapping
	domainInfo := types.ProjectDomain{
		ProjectHostname: project.Hostname,
		Domain:          fullDomain,
		DNSRecord: types.CloudflareDNSRecord{
			RecordID: record.ID,
			Name:     fullDomain,
			Content:  c.serverAddr,
			Type:     "A",
			Proxied:  true,
		},
	}

	c.domainMap[project.Hostname] = domainInfo
	log.Printf("Cloudflare: Created DNS record for %s (ID: %s)", fullDomain, record.ID)

	return &domainInfo, nil
}

// DeleteDomain removes a domain and its DNS record
func (c *Client) DeleteDomain(ctx context.Context, hostname string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	domainInfo, exists := c.domainMap[hostname]
	if !exists {
		return fmt.Errorf("no domain found for project hostname: %s", hostname)
	}

	// If not enabled, just remove from local map
	if !c.config.Enabled {
		log.Printf("Cloudflare: Integration disabled. Would delete domain for hostname '%s'", hostname)
		delete(c.domainMap, hostname)
		return nil
	}

	if domainInfo.DNSRecord.RecordID == "" {
		return fmt.Errorf("no DNS record ID found for domain: %s", domainInfo.Domain)
	}

	log.Printf("Cloudflare: Deleting DNS record for %s (ID: %s)", domainInfo.Domain, domainInfo.DNSRecord.RecordID)

	err := c.api.DeleteDNSRecord(ctx, cf.ZoneIdentifier(c.config.ZoneID), domainInfo.DNSRecord.RecordID)
	if err != nil {
		return fmt.Errorf("failed to delete DNS record: %w", err)
	}

	delete(c.domainMap, hostname)
	log.Printf("Cloudflare: Deleted DNS record for %s", domainInfo.Domain)

	return nil
}

// GetDomain retrieves domain information for a project
func (c *Client) GetDomain(hostname string) (types.ProjectDomain, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	domain, exists := c.domainMap[hostname]
	return domain, exists
}

// GetAllDomains returns all registered domains
func (c *Client) GetAllDomains() []types.ProjectDomain {
	c.mu.RLock()
	defer c.mu.RUnlock()

	domains := make([]types.ProjectDomain, 0, len(c.domainMap))
	for _, domain := range c.domainMap {
		domains = append(domains, domain)
	}
	return domains
}

// sanitizeForDNS removes characters that aren't valid in a DNS name
// and ensures it follows DNS naming conventions
func sanitizeForDNS(name string) string {
	// Replace spaces and special chars with hyphens
	sanitized := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			return r
		}
		if r >= 'A' && r <= 'Z' {
			return r + 32 // Convert to lowercase
		}
		return '-'
	}, name)

	// Remove consecutive hyphens
	for strings.Contains(sanitized, "--") {
		sanitized = strings.ReplaceAll(sanitized, "--", "-")
	}

	// Ensure it doesn't start or end with a hyphen
	sanitized = strings.Trim(sanitized, "-")

	// Ensure it's not empty after sanitization
	if sanitized == "" {
		sanitized = "app"
	}

	return sanitized
}
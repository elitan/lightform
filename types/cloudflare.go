package types

// CloudflareConfig holds configuration for Cloudflare integration
type CloudflareConfig struct {
	Enabled      bool   `json:"enabled"`       // Whether Cloudflare integration is enabled
	APIToken     string `json:"api_token"`     // Cloudflare API token for authentication
	ZoneID       string `json:"zone_id"`       // Cloudflare Zone ID
	BaseDomain   string `json:"base_domain"`   // Base domain for subdomains, e.g. "example.com"
	AutoGenerate bool   `json:"auto_generate"` // Whether to automatically generate subdomains
}

// CloudflareDNSRecord represents a DNS record created for a project
type CloudflareDNSRecord struct {
	RecordID string `json:"record_id"` // Cloudflare Record ID
	Name     string `json:"name"`      // The full domain name, e.g. "myapp.example.com"
	Content  string `json:"content"`   // IP address or CNAME value
	Type     string `json:"type"`      // "A" or "CNAME"
	Proxied  bool   `json:"proxied"`   // Whether the record is proxied through Cloudflare
}

// ProjectDomain extends ProjectState with domain information
type ProjectDomain struct {
	ProjectHostname string            `json:"project_hostname"` // Original project hostname
	Domain          string            `json:"domain"`           // The assigned domain
	DNSRecord       CloudflareDNSRecord `json:"dns_record,omitempty"` // DNS record details
}
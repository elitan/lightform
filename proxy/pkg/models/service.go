package models

// Service represents a deployed service with its routing configuration
type Service struct {
	Name       string `json:"name"`
	Host       string `json:"host"`
	Target     string `json:"target"`     // Network alias:port for apps (e.g., "blog:3000")
	Project    string `json:"project"`    // Project identifier to distinguish between docker networks
	Healthy    bool   `json:"healthy"`    // Health status of the target
	HealthPath string `json:"healthPath"` // Health check endpoint path (default: "/up")
}

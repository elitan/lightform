package models

// Service represents a deployed service with its routing configuration
type Service struct {
	Name    string `json:"name"`
	Host    string `json:"host"`
	Target  string `json:"target"`
	Project string `json:"project"` // Project identifier to distinguish between docker networks
}

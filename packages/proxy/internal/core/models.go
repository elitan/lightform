package core

import "time"

// Deployment represents a blue-green deployment
type Deployment struct {
	ID        string
	Hostname  string
	Blue      Container
	Green     Container
	Active    Color
	UpdatedAt time.Time
}

// Container represents a deployed container
type Container struct {
	ID          string
	Target      string // "localhost:3001"
	HealthPath  string // "/health"
	HealthState HealthState
	StartedAt   time.Time
}

// Color represents blue or green in deployments
type Color string

const (
	Blue  Color = "blue"
	Green Color = "green"
)

// HealthState represents container health
type HealthState string

const (
	HealthUnknown   HealthState = "unknown"
	HealthChecking  HealthState = "checking"
	HealthHealthy   HealthState = "healthy"
	HealthUnhealthy HealthState = "unhealthy"
	HealthStopped   HealthState = "stopped"
)

// Route represents the active routing configuration
type Route struct {
	Hostname string
	Target   string
	Healthy  bool
}

// Event represents a deployment event
type Event interface {
	EventTime() time.Time
}

// BaseEvent provides common event fields
type BaseEvent struct {
	Timestamp time.Time
	Hostname  string
}

func (e BaseEvent) EventTime() time.Time {
	return e.Timestamp
}

// DeploymentStarted indicates a new deployment has begun
type DeploymentStarted struct {
	BaseEvent
	DeploymentID string
	Color        Color
	Target       string
}

// HealthCheckPassed indicates a container passed health checks
type HealthCheckPassed struct {
	BaseEvent
	DeploymentID string
	Color        Color
}

// TrafficSwitched indicates traffic was switched to a new container
type TrafficSwitched struct {
	BaseEvent
	DeploymentID string
	FromColor    Color
	ToColor      Color
	FromTarget   string
	ToTarget     string
}

// DeploymentCompleted indicates a deployment finished successfully
type DeploymentCompleted struct {
	BaseEvent
	DeploymentID string
	Color        Color
}

// DeploymentFailed indicates a deployment failed
type DeploymentFailed struct {
	BaseEvent
	DeploymentID string
	Color        Color
	Error        string
}
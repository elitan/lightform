package types

import "time"

// Project holds the configuration for a user's project.
type Project struct {
	Name          string            `json:"name"`           // Unique identifier for the project
	DockerImage   string            `json:"docker_image"`   // Name of the Docker image to run
	EnvVars       map[string]string `json:"env_vars"`       // Environment variables for the container
	ContainerPort int               `json:"container_port"` // Port the application inside the container listens on
	Hostname      string            `json:"hostname"`       // Hostname used to route requests to this project
}

// ProjectState holds the runtime state of a project.
type ProjectState struct {
	ProjectConfig Project
	ContainerID   string    // ID of the running container, empty if not running
	HostPort      int       // Dynamically assigned port on the host
	LastRequest   time.Time // Timestamp of the last request processed for this project
	IsRunning     bool
}

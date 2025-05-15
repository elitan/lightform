package types

// ContainerState represents the possible states of a container
type ContainerState string

const (
	// Container lifecycle states
	StateIdle     ContainerState = "idle"     // Not started yet
	StateStarting ContainerState = "starting" // In process of starting
	StateRunning  ContainerState = "running"  // Running and ready
	StateStopping ContainerState = "stopping" // In process of stopping
	StateStopped  ContainerState = "stopped"  // Stopped
)

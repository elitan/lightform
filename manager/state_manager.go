package manager

import (
	"sync"
	"time"

	"luma/types"
)

// StateManager manages the in-memory state of projects and their containers.
type StateManager struct {
	mu       sync.RWMutex
	projects map[string]*types.ProjectState // Key: Hostname
}

// NewStateManager creates a new StateManager.
func NewStateManager() *StateManager {
	return &StateManager{
		projects: make(map[string]*types.ProjectState),
	}
}

// RegisterProject registers a new project or updates an existing one.
// It uses hostname as the primary key.
func (sm *StateManager) RegisterProject(project types.Project) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// TODO: Add validation for project details (e.g., unique hostname, valid port)
	sm.projects[project.Hostname] = &types.ProjectState{
		ProjectConfig: project,
		IsRunning:     false,
	}
	return nil
}

// GetProjectByHostname retrieves a project's state by its hostname.
func (sm *StateManager) GetProjectByHostname(hostname string) (*types.ProjectState, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	projectState, exists := sm.projects[hostname]
	return projectState, exists
}

// UpdateContainerStatus updates the container ID, host port, and running status for a project.
func (sm *StateManager) UpdateContainerStatus(hostname string, containerID string, hostPort int, isRunning bool) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if projectState, exists := sm.projects[hostname]; exists {
		projectState.ContainerID = containerID
		projectState.HostPort = hostPort
		projectState.IsRunning = isRunning
		if isRunning {
			projectState.LastRequest = time.Now()
		}
	}
}

// UpdateLastRequestTime updates the last request timestamp for a project.
func (sm *StateManager) UpdateLastRequestTime(hostname string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if projectState, exists := sm.projects[hostname]; exists && projectState.IsRunning {
		projectState.LastRequest = time.Now()
	}
}

// GetAllProjects returns a snapshot of all project states.
// This is used by the inactivity monitor.
func (sm *StateManager) GetAllProjects() []*types.ProjectState {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	states := make([]*types.ProjectState, 0, len(sm.projects))
	for _, state := range sm.projects {
		// Defensive copy, though ProjectState itself is small.
		// For LastRequest, time.Time is a struct, so it's copied.
		// ProjectConfig is a struct, also copied.
		// ContainerID and IsRunning are basic types, copied.
		sCopy := *state
		states = append(states, &sCopy)
	}
	return states
}

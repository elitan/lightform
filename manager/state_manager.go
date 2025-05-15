package manager

import (
	"sync"
	"time"

	"log" // Uncomment for debugging

	"luma/types"
)

// ContainerState is an alias for types.ContainerState to avoid having to qualify it every time
type ContainerState = types.ContainerState

// Aliases for the container state constants to avoid having to qualify them
const (
	StateIdle     = types.StateIdle
	StateStarting = types.StateStarting
	StateRunning  = types.StateRunning
	StateStopping = types.StateStopping
	StateStopped  = types.StateStopped
)

// startAttempt holds information about an ongoing or recently completed container start attempt.
type startAttempt struct {
	done   chan struct{} // Closed when start attempt is complete (success or failure)
	once   sync.Once     // Ensures 'done' channel is closed only once
	active bool          // True if a start attempt is considered actively in progress
}

// StateManager manages the in-memory state of projects and their containers.
type StateManager struct {
	mu            sync.RWMutex
	projects      map[string]*types.ProjectState // Key: Hostname
	startingLocks map[string]*startAttempt       // Key: Hostname, to manage concurrent start attempts
	muStarting    sync.Mutex                     // Mutex for startingLocks map
}

// NewStateManager creates a new StateManager.
func NewStateManager() *StateManager {
	return &StateManager{
		projects:      make(map[string]*types.ProjectState),
		startingLocks: make(map[string]*startAttempt),
		// muStarting is initialized as a zero-value sync.Mutex
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
		State:         StateIdle,
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

		// Update the container state based on isRunning
		if isRunning {
			projectState.State = StateRunning
			projectState.LastRequest = time.Now()
		} else if containerID == "" {
			projectState.State = StateIdle
		} else {
			projectState.State = StateStopped
		}
		// If a project is now definitively running or not running,
		// any "active" start attempt might be considered complete or superseded.
		// However, SignalStartAttemptComplete is the primary way to manage the lifecycle of a startAttempt.
	}
}

// UpdateLastRequestTime updates the last request timestamp for a project.
func (sm *StateManager) UpdateLastRequestTime(hostname string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if projectState, exists := sm.projects[hostname]; exists && projectState.State == StateRunning {
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

// getContainerState returns the current state of a container (thread-safe, internal use).
func (sm *StateManager) getContainerState(hostname string) ContainerState {
	projectState, exists := sm.projects[hostname]
	if !exists {
		return StateIdle
	}
	return projectState.State
}

// GetContainerState returns the current state of a container (thread-safe).
func (sm *StateManager) GetContainerState(hostname string) ContainerState {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.getContainerState(hostname)
}

// EnsureProjectStarting manages the process of initiating a container start.
// It returns a channel that will be closed when the start attempt is complete,
// and a boolean indicating if the caller is the one responsible for initiating the start.
func (sm *StateManager) EnsureProjectStarting(hostname string) (waitChan <-chan struct{}, isInitiator bool) {
	sm.muStarting.Lock()
	defer sm.muStarting.Unlock()

	// First check if the project is already running or in stopping state
	sm.mu.RLock()
	currentState := sm.getContainerState(hostname)
	sm.mu.RUnlock()

	if currentState == StateRunning {
		// Create a dummy, already closed channel to indicate no waiting is needed
		done := make(chan struct{})
		close(done)
		return done, false
	} else if currentState == StateStopping {
		// If container is currently stopping, we need to wait for it to complete before starting
		// Set state to handle the transition
		sm.mu.Lock()
		if projectState, exists := sm.projects[hostname]; exists {
			projectState.State = StateStarting
		}
		sm.mu.Unlock()
	}

	sa, exists := sm.startingLocks[hostname]
	if !exists || !sa.active { // If no lock, or lock exists but is from a completed/failed previous attempt
		log.Printf("StateManager: EnsureProjectStarting - No active start for '%s'. Creating new lock. Initiator=true", hostname)
		sa = &startAttempt{
			done:   make(chan struct{}),
			active: true, // Mark as actively starting
		}
		sm.startingLocks[hostname] = sa

		// Update project state to "starting"
		sm.mu.Lock()
		if projectState, exists := sm.projects[hostname]; exists {
			projectState.State = StateStarting
		}
		sm.mu.Unlock()

		isInitiator = true
	} else {
		log.Printf("StateManager: EnsureProjectStarting - Active start found for '%s'. Initiator=false", hostname)
		isInitiator = false // Another goroutine is already handling the start
	}
	return sa.done, isInitiator
}

// SignalStartAttemptComplete marks the container start attempt as complete for a given hostname.
// This is called by the goroutine that actually performed the start operation (success or failure).
func (sm *StateManager) SignalStartAttemptComplete(hostname string) {
	sm.muStarting.Lock()
	defer sm.muStarting.Unlock()

	sa, exists := sm.startingLocks[hostname]
	if exists && sa.active {
		log.Printf("StateManager: SignalStartAttemptComplete - Signaling completion for '%s'", hostname)
		sa.once.Do(func() {
			close(sa.done)
		})
		sa.active = false // Mark as no longer actively starting
		// Remove the entry from the map as this specific attempt is now finished.
		// This allows a new attempt if this one failed and the project is still not running.
		delete(sm.startingLocks, hostname)
	} else {
		log.Printf("StateManager: SignalStartAttemptComplete - No active lock to complete for '%s' or already signaled.", hostname)
	}
}

// MarkContainerStopping updates the project state to indicate the container is being stopped.
func (sm *StateManager) MarkContainerStopping(hostname string) bool {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Only transition to stopping if it was previously running
	if projectState, exists := sm.projects[hostname]; exists && projectState.State == StateRunning {
		projectState.State = StateStopping
		return true
	}
	return false
}

// MarkContainerStopped updates the project state to indicate the container is fully stopped.
func (sm *StateManager) MarkContainerStopped(hostname string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if projectState, exists := sm.projects[hostname]; exists {
		projectState.State = StateStopped
		projectState.IsRunning = false
	}
}

// CanStartContainer checks if a container can be started (not in stopping state).
func (sm *StateManager) CanStartContainer(hostname string) bool {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	return sm.getContainerState(hostname) != StateStopping
}

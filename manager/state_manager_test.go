package manager

import (
	"testing"
	"time"

	"luma/types"
)

// TestContainerStateTransitions tests the state transitions of containers
func TestContainerStateTransitions(t *testing.T) {
	sm := NewStateManager()

	// Register a test project
	project := types.Project{
		Name:          "test-project",
		Hostname:      "test.local",
		DockerImage:   "nginx:latest",
		ContainerPort: 80,
		EnvVars:       map[string]string{"ENV": "test"},
	}

	err := sm.RegisterProject(project)
	if err != nil {
		t.Fatalf("Failed to register project: %v", err)
	}

	// Get initial state
	containerState := sm.GetContainerState("test.local")
	if containerState != StateIdle {
		t.Errorf("Expected initial state to be StateIdle, got %s", containerState)
	}

	// Test transition to starting
	_, isInitiator := sm.EnsureProjectStarting("test.local")
	if !isInitiator {
		t.Error("Expected to be the initiator for the first start attempt")
	}

	containerState = sm.GetContainerState("test.local")
	if containerState != StateStarting {
		t.Errorf("Expected state to be StateStarting after EnsureProjectStarting, got %s", containerState)
	}

	// Test another start attempt while already starting
	_, isInitiator = sm.EnsureProjectStarting("test.local")
	if isInitiator {
		t.Error("Should not be initiator for a second start attempt while already starting")
	}

	// Signal start complete and transition to running
	sm.SignalStartAttemptComplete("test.local")
	sm.UpdateContainerStatus("test.local", "container123", 8080, true)

	containerState = sm.GetContainerState("test.local")
	if containerState != StateRunning {
		t.Errorf("Expected state to be StateRunning after UpdateContainerStatus with isRunning=true, got %s", containerState)
	}

	// Test that last request time is updated only when running
	initialTime := time.Now().Add(-time.Hour) // Set an old time
	projectState, _ := sm.GetProjectByHostname("test.local")
	projectState.LastRequest = initialTime

	sm.UpdateLastRequestTime("test.local")
	projectState, _ = sm.GetProjectByHostname("test.local")
	if projectState.LastRequest.Equal(initialTime) {
		t.Error("Last request time should have been updated")
	}

	// Test transition to stopping
	wasMarked := sm.MarkContainerStopping("test.local")
	if !wasMarked {
		t.Error("Expected MarkContainerStopping to return true for a running container")
	}

	containerState = sm.GetContainerState("test.local")
	if containerState != StateStopping {
		t.Errorf("Expected state to be StateStopping after MarkContainerStopping, got %s", containerState)
	}

	// Test that we can't start a container that's in stopping state
	canStart := sm.CanStartContainer("test.local")
	if canStart {
		t.Error("Should not be able to start a container that's in stopping state")
	}

	// Test transition to stopped
	sm.MarkContainerStopped("test.local")
	containerState = sm.GetContainerState("test.local")
	if containerState != StateStopped {
		t.Errorf("Expected state to be StateStopped after MarkContainerStopped, got %s", containerState)
	}

	// Verify IsRunning was also updated
	projectState, _ = sm.GetProjectByHostname("test.local")
	if projectState.IsRunning {
		t.Error("IsRunning should be false after container is stopped")
	}

	// Test that we can start a container that's in stopped state
	canStart = sm.CanStartContainer("test.local")
	if !canStart {
		t.Error("Should be able to start a container that's in stopped state")
	}

	// Test transition back to starting
	_, isInitiator = sm.EnsureProjectStarting("test.local")
	if !isInitiator {
		t.Error("Expected to be the initiator for starting a stopped container")
	}

	containerState = sm.GetContainerState("test.local")
	if containerState != StateStarting {
		t.Errorf("Expected state to be StateStarting after EnsureProjectStarting on a stopped container, got %s", containerState)
	}

	// Test the edge case where a container is stopping but receives a new start request
	// First mark it as stopping
	sm.SignalStartAttemptComplete("test.local")
	sm.UpdateContainerStatus("test.local", "container123", 8080, true)
	sm.MarkContainerStopping("test.local")

	// Then try to start it
	_, isInitiator = sm.EnsureProjectStarting("test.local")
	if !isInitiator {
		t.Error("Expected to be the initiator for a container transitioning from stopping to starting")
	}

	containerState = sm.GetContainerState("test.local")
	if containerState != StateStarting {
		t.Errorf("Expected state to be StateStarting after EnsureProjectStarting on a stopping container, got %s", containerState)
	}
}

// TestConcurrentStartAttempts tests that multiple start attempts for the same hostname
// are properly coordinated
func TestConcurrentStartAttempts(t *testing.T) {
	sm := NewStateManager()

	// Register a test project
	project := types.Project{
		Name:          "test-project",
		Hostname:      "test.local",
		DockerImage:   "nginx:latest",
		ContainerPort: 80,
	}

	err := sm.RegisterProject(project)
	if err != nil {
		t.Fatalf("Failed to register project: %v", err)
	}

	// First start attempt should be the initiator
	waitChan1, isInitiator1 := sm.EnsureProjectStarting("test.local")
	if !isInitiator1 {
		t.Error("First attempt should be the initiator")
	}

	// Second attempt should not be the initiator and should wait on the same channel
	waitChan2, isInitiator2 := sm.EnsureProjectStarting("test.local")
	if isInitiator2 {
		t.Error("Second attempt should not be the initiator")
	}

	// The channels should be the same
	if waitChan1 != waitChan2 {
		t.Error("Both wait channels should be the same for concurrent start attempts")
	}

	// Signal completion
	sm.SignalStartAttemptComplete("test.local")

	// Create a timeout to prevent deadlock in case the test fails
	timeout := time.After(time.Second)

	// Verify both channels were closed
	select {
	case <-waitChan1:
		// Channel was closed, which is expected
	case <-timeout:
		t.Error("Timed out waiting for waitChan1 to close")
	}

	select {
	case <-waitChan2:
		// Channel was closed, which is expected
	case <-timeout:
		t.Error("Timed out waiting for waitChan2 to close")
	}

	// After completion, a new start attempt should be the initiator again
	_, isInitiator3 := sm.EnsureProjectStarting("test.local")
	if !isInitiator3 {
		t.Error("After completion, a new attempt should be the initiator")
	}
}

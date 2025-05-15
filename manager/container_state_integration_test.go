//go:build integration
// +build integration

package manager

import (
	"context"
	"sync"
	"testing"
	"time"

	"luma/types"
)

// This is an integration test that verifies the container state management
// works correctly when handling concurrent requests during state transitions.
// This test requires Docker to be running.
// Run with: go test -tags=integration

// TestContainerStateTransitionsWithRealManager tests container state transitions
// with the actual ContainerManager and StateManager
func TestContainerStateTransitionsWithRealManager(t *testing.T) {
	// Skip in short mode
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	// Create managers
	stateManager := NewStateManager()
	containerManager, err := NewContainerManager(stateManager)
	if err != nil {
		t.Fatalf("Failed to create ContainerManager: %v", err)
	}

	// Register a test project with a simple image
	project := types.Project{
		Name:          "state-test-project",
		Hostname:      "state-test.local",
		DockerImage:   "nginx:alpine", // Small image for faster tests
		ContainerPort: 80,
	}

	err = stateManager.RegisterProject(project)
	if err != nil {
		t.Fatalf("Failed to register project: %v", err)
	}

	// Background context with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Test basic state transitions
	t.Run("BasicStateTransitions", func(t *testing.T) {
		// 1. Start a container
		waitChan, isInitiator := stateManager.EnsureProjectStarting(project.Hostname)
		if !isInitiator {
			t.Fatal("Expected to be the initiator")
		}

		currentState := stateManager.GetContainerState(project.Hostname)
		if currentState != StateStarting {
			t.Errorf("Expected state to be StateStarting, got %s", currentState)
		}

		// Start container in a goroutine
		var startErr error
		var containerID string
		var hostPort int
		wg := sync.WaitGroup{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer stateManager.SignalStartAttemptComplete(project.Hostname)

			containerID, hostPort, startErr = containerManager.StartContainer(ctx, project)
			if startErr == nil {
				stateManager.UpdateContainerStatus(project.Hostname, containerID, hostPort, true)
			} else {
				stateManager.UpdateContainerStatus(project.Hostname, "", 0, false)
			}
		}()

		// Wait for container to start
		select {
		case <-waitChan:
			// Container start attempt completed
		case <-ctx.Done():
			t.Fatal("Context deadline exceeded waiting for container to start")
		}

		// Wait for goroutine to complete
		wg.Wait()

		if startErr != nil {
			t.Fatalf("Failed to start container: %v", startErr)
		}

		// 2. Verify container is running
		currentState = stateManager.GetContainerState(project.Hostname)
		if currentState != StateRunning {
			t.Errorf("Expected state to be StateRunning after starting, got %s", currentState)
		}

		projectState, exists := stateManager.GetProjectByHostname(project.Hostname)
		if !exists {
			t.Fatal("Project should exist")
		}
		if !projectState.IsRunning {
			t.Error("IsRunning should be true")
		}
		if projectState.ContainerID == "" {
			t.Error("ContainerID should not be empty")
		}
		if projectState.HostPort <= 0 {
			t.Error("HostPort should be positive")
		}

		// 3. Stop the container
		wasMarked := stateManager.MarkContainerStopping(project.Hostname)
		if !wasMarked {
			t.Error("MarkContainerStopping should return true for running container")
		}

		currentState = stateManager.GetContainerState(project.Hostname)
		if currentState != StateStopping {
			t.Errorf("Expected state to be StateStopping, got %s", currentState)
		}

		stopErr := containerManager.StopContainer(ctx, projectState.ContainerID)
		if stopErr != nil {
			t.Fatalf("Failed to stop container: %v", stopErr)
		}

		stateManager.MarkContainerStopped(project.Hostname)

		// 4. Verify container is stopped
		currentState = stateManager.GetContainerState(project.Hostname)
		if currentState != StateStopped {
			t.Errorf("Expected state to be StateStopped, got %s", currentState)
		}

		projectState, _ = stateManager.GetProjectByHostname(project.Hostname)
		if projectState.IsRunning {
			t.Error("IsRunning should be false after stopping")
		}
	})

	// Test the edge case where a container is being stopped but gets a new request
	t.Run("EdgeCaseStoppingThenNewRequest", func(t *testing.T) {
		// 1. Start container again
		waitChan, _ := stateManager.EnsureProjectStarting(project.Hostname)

		var startErr error
		var containerID string
		var hostPort int
		wg := sync.WaitGroup{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer stateManager.SignalStartAttemptComplete(project.Hostname)

			containerID, hostPort, startErr = containerManager.StartContainer(ctx, project)
			if startErr == nil {
				stateManager.UpdateContainerStatus(project.Hostname, containerID, hostPort, true)
			} else {
				stateManager.UpdateContainerStatus(project.Hostname, "", 0, false)
			}
		}()

		// Wait for container to start
		select {
		case <-waitChan:
			// Container start attempt completed
		case <-ctx.Done():
			t.Fatal("Context deadline exceeded waiting for container to start")
		}

		// Wait for goroutine to complete
		wg.Wait()

		if startErr != nil {
			t.Fatalf("Failed to start container: %v", startErr)
		}

		// 2. Begin stopping the container
		projectState, _ := stateManager.GetProjectByHostname(project.Hostname)
		wasMarked := stateManager.MarkContainerStopping(project.Hostname)
		if !wasMarked {
			t.Fatal("MarkContainerStopping should return true for a running container")
		}

		// 3. Before it's fully stopped, try to start it again (simulating a new request)
		// This should detect it's stopping and handle that edge case
		_, isInitiator := stateManager.EnsureProjectStarting(project.Hostname)
		if !isInitiator {
			t.Error("Expected to be initiator for a container in stopping state")
		}

		// Verify state was updated to starting
		currentState := stateManager.GetContainerState(project.Hostname)
		if currentState != StateStarting {
			t.Errorf("Expected state to be StateStarting after EnsureProjectStarting when container was stopping, got %s", currentState)
		}

		// Cleanup: Signal completion and stop the container
		stateManager.SignalStartAttemptComplete(project.Hostname)
		_ = containerManager.StopContainer(ctx, projectState.ContainerID)
		stateManager.MarkContainerStopped(project.Hostname)
	})

	// Final cleanup
	projectState, exists := stateManager.GetProjectByHostname(project.Hostname)
	if exists && projectState.ContainerID != "" {
		_ = containerManager.StopContainer(ctx, projectState.ContainerID)
	}
}

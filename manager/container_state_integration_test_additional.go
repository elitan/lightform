// +build integration

package manager

import (
	"context"
	"testing"
	"time"

	"luma/types"
)

func TestContainerLifecycle_Integration(t *testing.T) {
	// Skip in CI unless explicitly enabled with TEST_INTEGRATION_DOCKER=true
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	// Create managers
	stateManager := NewStateManager()
	containerManager, err := NewContainerManager(stateManager)
	if err != nil {
		t.Fatalf("Failed to create ContainerManager: %v", err)
	}

	// Create test project
	project := types.Project{
		Name:          "test-integration",
		DockerImage:   "nginx:alpine",
		EnvVars:       map[string]string{"TEST": "value"},
		ContainerPort: 80,
		Hostname:      "test-integration.localhost",
	}

	// Register project
	err = stateManager.RegisterProject(project)
	if err != nil {
		t.Fatalf("Failed to register project: %v", err)
	}

	// Start container
	ctx := context.Background()
	containerID, hostPort, err := containerManager.StartContainer(ctx, project)
	if err != nil {
		t.Fatalf("Failed to start container: %v", err)
	}

	// Verify container is running
	if containerID == "" {
		t.Fatal("Expected container ID to be non-empty")
	}
	if hostPort <= 0 {
		t.Fatalf("Expected host port to be positive, got %d", hostPort)
	}

	t.Logf("Started container: ID=%s, HostPort=%d", containerID, hostPort)

	// Update state
	stateManager.UpdateContainerStatus(project.Hostname, containerID, hostPort, true)
	
	// Check state
	containerState := stateManager.GetContainerState(project.Hostname)
	if containerState != StateRunning {
		t.Errorf("Expected container state to be StateRunning, got %v", containerState)
	}

	// Stop container
	err = containerManager.SafelyStopProjectContainer(ctx, project.Hostname)
	if err != nil {
		t.Fatalf("Failed to stop container: %v", err)
	}

	// Check state after stopping
	containerState = stateManager.GetContainerState(project.Hostname)
	if containerState != StateStopped {
		t.Errorf("Expected container state to be StateStopped, got %v", containerState)
	}

	t.Logf("Successfully stopped container: ID=%s", containerID)
}

func TestInactivityMonitor_Integration(t *testing.T) {
	// Skip in CI unless explicitly enabled with TEST_INTEGRATION_DOCKER=true
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	// Create managers
	stateManager := NewStateManager()
	containerManager, err := NewContainerManager(stateManager)
	if err != nil {
		t.Fatalf("Failed to create ContainerManager: %v", err)
	}

	// Create test project
	project := types.Project{
		Name:          "test-inactivity",
		DockerImage:   "nginx:alpine",
		EnvVars:       map[string]string{},
		ContainerPort: 80,
		Hostname:      "test-inactivity.localhost",
	}

	// Register project
	err = stateManager.RegisterProject(project)
	if err != nil {
		t.Fatalf("Failed to register project: %v", err)
	}

	// Start container
	ctx := context.Background()
	containerID, hostPort, err := containerManager.StartContainer(ctx, project)
	if err != nil {
		t.Fatalf("Failed to start container: %v", err)
	}

	// Update state to running
	stateManager.UpdateContainerStatus(project.Hostname, containerID, hostPort, true)
	
	// Mark last request as 30 seconds ago (force inactivity)
	projectState, _ := stateManager.GetProjectByHostname(project.Hostname)
	projectState.LastRequest = time.Now().Add(-30 * time.Second)

	// Create short-lived context for inactivity monitor
	monitorCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Setup inactivity monitor
	inactivityTimeout := 2 * time.Second   // Very short timeout for test
	checkInterval := 500 * time.Millisecond // Short check interval

	done := make(chan struct{})
	
	// Start monitor in background
	go func() {
		// Create a simple monitor function similar to ReverseProxyHandler.InactivityMonitor
		ticker := time.NewTicker(checkInterval)
		defer ticker.Stop()

		for {
			select {
			case <-monitorCtx.Done():
				close(done)
				return
			case <-ticker.C:
				t.Log("Checking for inactive containers...")
				
				projects := stateManager.GetAllProjects()
				for _, pState := range projects {
					containerState := stateManager.GetContainerState(pState.ProjectConfig.Hostname)
					
					if containerState == StateRunning {
						timeSinceLastRequest := time.Since(pState.LastRequest)
						if timeSinceLastRequest > inactivityTimeout {
							t.Logf("Project '%s' inactive for %v, stopping...", pState.ProjectConfig.Name, timeSinceLastRequest)
							err := containerManager.SafelyStopProjectContainer(ctx, pState.ProjectConfig.Hostname)
							if err != nil {
								t.Logf("Error stopping container: %v", err)
							}
						}
					}
				}
			}
		}
	}()

	// Wait for monitor to complete
	<-done
	
	// Check if container was stopped due to inactivity
	containerState := stateManager.GetContainerState(project.Hostname)
	if containerState != StateStopped {
		t.Errorf("Expected container state to be StateStopped after inactivity, got %v", containerState)
	} else {
		t.Log("Container successfully stopped due to inactivity")
	}
}
package manager

import (
	"context"
	"fmt"
	"io"
	"log"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"

	"luma/types"
)

// ContainerManager interacts with the Docker daemon to manage containers.
type ContainerManager struct {
	dockerClient *client.Client
	stateManager *StateManager // Reference to the StateManager
}

// NewContainerManager creates a new ContainerManager.
func NewContainerManager(stateManager *StateManager) (*ContainerManager, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("failed to create docker client: %w", err)
	}
	return &ContainerManager{
		dockerClient: cli,
		stateManager: stateManager,
	}, nil
}

// StartContainer starts a new Docker container based on the project configuration.
func (cm *ContainerManager) StartContainer(ctx context.Context, project types.Project) (string, int, error) {
	// First check if we're allowed to start (not in stopping state)
	if !cm.stateManager.CanStartContainer(project.Hostname) {
		return "", 0, fmt.Errorf("cannot start container for project %s: container is in stopping state", project.Hostname)
	}

	imageName := project.DockerImage
	log.Printf("ContainerManager: Attempting to pull image '%s' for project '%s'...", imageName, project.Name)

	// Pull the image if it doesn't exist locally
	reader, err := cm.dockerClient.ImagePull(ctx, imageName, image.PullOptions{})
	if err != nil {
		log.Printf("ContainerManager: Failed to pull image '%s': %v", imageName, err)
		return "", 0, fmt.Errorf("failed to pull image %s: %w", imageName, err)
	}
	// Suppressing ImagePull output for cleaner logs, but it can be useful for debugging.
	// io.Copy(os.Stdout, reader)
	if _, err := io.Copy(io.Discard, reader); err != nil {
			log.Printf("ContainerManager: Warning: Failed to discard output from image pull: %v", err)
		} // Discard the output to prevent cluttering logs
	reader.Close()
	log.Printf("ContainerManager: Image '%s' pulled successfully (or was already present).", imageName)

	// Prepare environment variables, ensuring PORT is set from ContainerPort
	// User-defined PORT in project.EnvVars will override this default.
	effectiveEnvVars := make(map[string]string)
	if project.ContainerPort > 0 { // Only set if a valid port is given
		effectiveEnvVars["PORT"] = fmt.Sprintf("%d", project.ContainerPort)
	}

	// Apply user-defined environment variables, potentially overriding the default PORT
	for k, v := range project.EnvVars {
		effectiveEnvVars[k] = v
	}

	envList := []string{}
	for k, v := range effectiveEnvVars {
		envList = append(envList, fmt.Sprintf("%s=%s", k, v))
	}

	// Configure port exposure
	containerPortStr := fmt.Sprintf("%d/tcp", project.ContainerPort)
	exposedPorts := nat.PortSet{
		nat.Port(containerPortStr): struct{}{},
	}

	// Assign a dynamic host port
	portBindings := nat.PortMap{
		nat.Port(containerPortStr): []nat.PortBinding{
			{
				HostIP:   "0.0.0.0",
				HostPort: "", // Docker will assign a random available port
			},
		},
	}

	resp, err := cm.dockerClient.ContainerCreate(
		ctx,
		&container.Config{
			Image:        imageName,
			Env:          envList,
			ExposedPorts: exposedPorts,
			Tty:          false,
		},
		&container.HostConfig{
			PortBindings: portBindings, // Restored original PortBindings
			// PublishAllPorts: true, // Diagnostic change reverted
		},
		nil,          // NetworkingConfig
		nil,          // Platform
		project.Name, // Container name, using project name for simplicity
	)
	if err != nil {
		log.Printf("ContainerManager: Failed to create container for project '%s' with image '%s': %v", project.Name, imageName, err)
		return "", 0, fmt.Errorf("failed to create container for project %s: %w", project.Name, err)
	}

	log.Printf("ContainerManager: Container '%s' created for project '%s'. Attempting to start...", resp.ID, project.Name)

	if err := cm.dockerClient.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		log.Printf("ContainerManager: Failed to start container '%s' for project '%s': %v", resp.ID, project.Name, err)
		// Attempt to remove the created container if start fails
		if err := cm.dockerClient.ContainerRemove(context.Background(), resp.ID, container.RemoveOptions{Force: true}); err != nil {
			log.Printf("ContainerManager: Failed to remove container '%s' after failed start: %v", resp.ID, err)
		} // Best effort removal
		return "", 0, fmt.Errorf("failed to start container %s for project %s: %w", resp.ID, project.Name, err)
	}

	log.Printf("ContainerManager: Container '%s' for project '%s' started. Inspecting for port with retries...", resp.ID, project.Name)

	// Inspect the container to get the dynamically assigned host port, with retries
	var inspectData container.InspectResponse
	var hostPortStr string
	foundPort := false
	containerNatPort := nat.Port(containerPortStr) // e.g., "80/tcp"

	const maxRetries = 10                     // Max 10 retries
	const retryDelay = 500 * time.Millisecond // 500ms delay

	for i := 0; i < maxRetries; i++ {
		var inspectErr error
		inspectData, inspectErr = cm.dockerClient.ContainerInspect(ctx, resp.ID)
		if inspectErr != nil {
			log.Printf("ContainerManager: Failed to inspect container '%s' on attempt %d/%d: %v", resp.ID, i+1, maxRetries, inspectErr)
			// If inspect fails catastrophically, stopping might be wise, or we can let retries continue
			if i == maxRetries-1 { // Last attempt failed
				if err := cm.StopContainer(ctx, resp.ID); err != nil {
					log.Printf("ContainerManager: Failed to stop container '%s' after inspect failure: %v", resp.ID, err)
				} // Best effort stop
				return "", 0, fmt.Errorf("failed to inspect container %s after %d attempts: %w", resp.ID, maxRetries, inspectErr)
			}
			time.Sleep(retryDelay)
			continue
		}

		if inspectData.NetworkSettings != nil && inspectData.NetworkSettings.Ports != nil {
			if portBindings, ok := inspectData.NetworkSettings.Ports[containerNatPort]; ok {
				if len(portBindings) > 0 && portBindings[0].HostPort != "" {
					hostPortStr = portBindings[0].HostPort
					foundPort = true
					log.Printf("ContainerManager: Found host port '%s' for container '%s' on attempt %d/%d.", hostPortStr, resp.ID, i+1, maxRetries)
					break // Port found, exit retry loop
				}
			}
		}

		if i < maxRetries-1 {
			log.Printf("ContainerManager: Host port not yet found for container '%s' (port '%s') on attempt %d/%d. Retrying in %v...", resp.ID, containerNatPort, i+1, maxRetries, retryDelay)
			time.Sleep(retryDelay)
		} else {
			log.Printf("ContainerManager: Host port not found for container '%s' after %d attempts.", resp.ID, maxRetries)
		}
	}

	if !foundPort {
		log.Printf("ContainerManager: Could not find valid host port binding for container '%s' (project '%s', target port '%s') after %d retries.", resp.ID, project.Name, containerNatPort, maxRetries)
		log.Printf("ContainerManager: Dumping final inspectData.NetworkSettings.Ports for container '%s':", resp.ID)
		if inspectData.NetworkSettings != nil && inspectData.NetworkSettings.Ports != nil && len(inspectData.NetworkSettings.Ports) > 0 {
			for p, bList := range inspectData.NetworkSettings.Ports {
				if len(bList) > 0 {
					log.Printf("ContainerManager:   Available Port Map: Private '%s' -> Public '%s:%s' (Binding Count: %d)", p, bList[0].HostIP, bList[0].HostPort, len(bList))
				} else {
					log.Printf("ContainerManager:   Available Port Map: Private '%s' -> No public bindings listed", p)
				}
			}
		} else {
			log.Printf("ContainerManager:   inspectData.NetworkSettings.Ports is nil, empty, or contains no specific bindings.")
		}
		// Log basic container state from inspectData
		if inspectData.State != nil {
			log.Printf("ContainerManager: Container '%s' State: Status='%s', Running=%v, Error='%s', ExitCode=%d, StartedAt='%s', FinishedAt='%s'",
				resp.ID, inspectData.State.Status, inspectData.State.Running, inspectData.State.Error, inspectData.State.ExitCode, inspectData.State.StartedAt, inspectData.State.FinishedAt)
		} else {
			log.Printf("ContainerManager: Container '%s' State: inspectData.State is nil.", resp.ID)
		}

		if err := cm.StopContainer(ctx, resp.ID); err != nil {
			log.Printf("ContainerManager: Failed to stop container '%s' after port binding issue: %v", resp.ID, err)
		} // Best effort stop
		return "", 0, fmt.Errorf("could not find valid host port binding for container %s (project %s, target port %s) after %d retries, container state: %+v", resp.ID, project.Name, containerNatPort, maxRetries, inspectData.State)
	}

	log.Printf("ContainerManager: Successfully obtained host port '%s' for container '%s'.", hostPortStr, resp.ID)
	hostPort, err := nat.ParsePort(hostPortStr)
	if err != nil {
		log.Printf("ContainerManager: Failed to parse host port '%s' for container '%s' (project '%s'). Stopping container. Error: %v", hostPortStr, resp.ID, project.Name, err)
		if err := cm.StopContainer(ctx, resp.ID); err != nil {
			log.Printf("ContainerManager: Failed to stop container '%s' after port binding issue: %v", resp.ID, err)
		} // Best effort stop
		return "", 0, fmt.Errorf("failed to parse host port %s: %w", hostPortStr, err)
	}

	log.Printf("ContainerManager: Successfully started and inspected container '%s' for project '%s'. Host port: %d", resp.ID, project.Name, hostPort)
	return resp.ID, int(hostPort), nil
}

// StopContainer stops and removes a Docker container by its ID.
func (cm *ContainerManager) StopContainer(ctx context.Context, containerID string) error {
	log.Printf("ContainerManager: Attempting to stop container '%s'...", containerID)
	// Stop the container
	// No timeout specified, docker daemon default (10s) will be used
	if err := cm.dockerClient.ContainerStop(ctx, containerID, container.StopOptions{}); err != nil {
		// Check if the error is "container not found" or similar, might already be stopped
		if !client.IsErrNotFound(err) {
			log.Printf("ContainerManager: Failed to stop container '%s' (it might already be stopped or removed): %v", containerID, err)
			// Do not return error if it's just not found or already stopped, as the goal is to ensure it's not running.
		} else {
			log.Printf("ContainerManager: Container '%s' not found during stop (already stopped/removed).", containerID)
		}
	} else {
		log.Printf("ContainerManager: Container '%s' stopped successfully. Attempting to remove...", containerID)
	}

	// Remove the container
	removeOptions := container.RemoveOptions{
		RemoveVolumes: true,
		Force:         false, // Don't force remove if it's still running, stop should handle it.
	}
	log.Printf("ContainerManager: Attempting to remove container '%s'...", containerID)
	if err := cm.dockerClient.ContainerRemove(ctx, containerID, removeOptions); err != nil {
		if !client.IsErrNotFound(err) {
			log.Printf("ContainerManager: Failed to remove container '%s': %v", containerID, err)
			return fmt.Errorf("failed to remove container %s: %w", containerID, err)
		} else {
			log.Printf("ContainerManager: Container '%s' not found during remove (already removed).", containerID)
		}
	}

	log.Printf("ContainerManager: Container '%s' successfully stopped and removed.", containerID)
	return nil
}

// SafelyStopProjectContainer safely stops a container for a project, handling state transitions.
// This should be used instead of StopContainer directly when stopping a project's container.
func (cm *ContainerManager) SafelyStopProjectContainer(ctx context.Context, hostname string) error {
	// First mark the container as stopping to prevent new requests from starting it
	wasMarkedStopping := cm.stateManager.MarkContainerStopping(hostname)
	if !wasMarkedStopping {
		// Container wasn't running, no need to stop it
		log.Printf("ContainerManager: SafelyStopProjectContainer - Project '%s' container was not running, no need to stop", hostname)
		return nil
	}

	// Get container details
	projectState, exists := cm.stateManager.GetProjectByHostname(hostname)
	if !exists || projectState.ContainerID == "" {
		// Project doesn't exist or has no container, mark as stopped
		cm.stateManager.MarkContainerStopped(hostname)
		return nil
	}

	containerID := projectState.ContainerID
	log.Printf("ContainerManager: SafelyStopProjectContainer - Stopping container '%s' for project '%s'", containerID, hostname)

	// Perform the actual container stop
	err := cm.StopContainer(ctx, containerID)

	// Update the state regardless of whether the stop succeeded
	cm.stateManager.MarkContainerStopped(hostname)

	if err != nil {
		return fmt.Errorf("failed to safely stop container for project %s: %w", hostname, err)
	}

	return nil
}

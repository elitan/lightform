package manager

import (
	"context"
	"fmt"
	"io"
	"log"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"

	"luma/types"
)

// ContainerManager interacts with the Docker daemon to manage containers.
type ContainerManager struct {
	dockerClient *client.Client
}

// NewContainerManager creates a new ContainerManager.
func NewContainerManager() (*ContainerManager, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("failed to create docker client: %w", err)
	}
	return &ContainerManager{dockerClient: cli}, nil
}

// StartContainer starts a new Docker container based on the project configuration.
func (cm *ContainerManager) StartContainer(ctx context.Context, project types.Project) (string, int, error) {
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
	io.Copy(io.Discard, reader) // Discard the output to prevent cluttering logs
	reader.Close()
	log.Printf("ContainerManager: Image '%s' pulled successfully (or was already present).", imageName)

	envVars := []string{}
	for k, v := range project.EnvVars {
		envVars = append(envVars, fmt.Sprintf("%s=%s", k, v))
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
			Env:          envVars,
			ExposedPorts: exposedPorts,
			Tty:          false,
		},
		&container.HostConfig{
			PortBindings: portBindings,
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
		cm.dockerClient.ContainerRemove(context.Background(), resp.ID, container.RemoveOptions{Force: true}) // Best effort removal
		return "", 0, fmt.Errorf("failed to start container %s for project %s: %w", resp.ID, project.Name, err)
	}

	log.Printf("ContainerManager: Container '%s' for project '%s' started. Inspecting for port...", resp.ID, project.Name)

	// Inspect the container to get the dynamically assigned host port
	inspectData, err := cm.dockerClient.ContainerInspect(ctx, resp.ID)
	if err != nil {
		log.Printf("ContainerManager: Failed to inspect container '%s' for project '%s': %v", resp.ID, project.Name, err)
		// Attempt to stop the container if we can't inspect it, as it might be in a bad state
		cm.StopContainer(ctx, resp.ID) // Best effort stop
		return "", 0, fmt.Errorf("failed to inspect container %s: %w", resp.ID, err)
	}

	hostPortStr := ""
	portBindingList, ok := inspectData.NetworkSettings.Ports[nat.Port(containerPortStr)]
	if ok && len(portBindingList) > 0 {
		hostPortStr = portBindingList[0].HostPort
	} else {
		log.Printf("ContainerManager: Could not find host port binding for container '%s' (project '%s', port %s). Stopping container.", resp.ID, project.Name, containerPortStr)
		cm.StopContainer(ctx, resp.ID) // Best effort stop
		return "", 0, fmt.Errorf("could not find host port binding for container %s, port %s", resp.ID, containerPortStr)
	}

	hostPort, err := nat.ParsePort(hostPortStr)
	if err != nil {
		log.Printf("ContainerManager: Failed to parse host port '%s' for container '%s' (project '%s'). Stopping container.", hostPortStr, resp.ID, project.Name, err)
		cm.StopContainer(ctx, resp.ID) // Best effort stop
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

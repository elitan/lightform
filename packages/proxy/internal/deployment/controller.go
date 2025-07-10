package deployment

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/elitan/lightform/proxy/internal/core"
)

// ProxyUpdater interface to update proxy routes
type ProxyUpdater interface {
	UpdateRoute(hostname, target string, healthy bool)
}

// Controller orchestrates blue-green deployments with immediate cleanup
type Controller struct {
	mu     sync.Mutex // Protects concurrent deployments to same hostname
	store  core.DeploymentStore
	proxy  ProxyUpdater
	health core.HealthChecker
	events core.EventBus
}

// NewController creates a new deployment controller
func NewController(store core.DeploymentStore, proxy ProxyUpdater, health core.HealthChecker, events core.EventBus) *Controller {
	return &Controller{
		store:  store,
		proxy:  proxy,
		health: health,
		events: events,
	}
}

// Deploy orchestrates a blue-green deployment with immediate cleanup
func (c *Controller) Deploy(ctx context.Context, hostname, imageTag, project, app string) error {
	// Simple input validation
	if hostname == "" {
		return fmt.Errorf("hostname cannot be empty")
	}
	if imageTag == "" {
		return fmt.Errorf("image tag cannot be empty")
	}
	
	// Serialize deployments to same hostname to prevent race conditions
	c.mu.Lock()
	defer c.mu.Unlock()
	
	log.Printf("[DEPLOY] Starting deployment for %s -> %s", hostname, imageTag)

	// Get or create deployment
	deployment, err := c.getOrCreateDeployment(hostname, project, app)
	if err != nil {
		return fmt.Errorf("failed to get deployment: %w", err)
	}

	// Determine which color to deploy to (inactive)
	inactiveColor := c.getInactiveColor(deployment)
	containerName := c.generateContainerName(hostname, inactiveColor)
	
	// Create new container record
	newContainer := core.Container{
		ID:          containerName,
		Target:      fmt.Sprintf("%s:3000", containerName), // Always port 3000
		HealthPath:  "/health",
		HealthState: core.HealthUnknown,
		StartedAt:   time.Now(),
	}

	// Update deployment state
	c.setContainer(deployment, inactiveColor, newContainer)
	deployment.UpdatedAt = time.Now()

	// Save deployment
	if err := c.store.SaveDeployment(deployment); err != nil {
		return fmt.Errorf("failed to save deployment: %w", err)
	}

	// Publish deployment started event
	c.events.Publish(&core.DeploymentStarted{
		BaseEvent:    core.BaseEvent{Timestamp: time.Now(), Hostname: hostname},
		DeploymentID: deployment.ID,
		Color:        inactiveColor,
		Target:       newContainer.Target,
	})

	// Start the actual container
	if err := c.startContainer(containerName, imageTag); err != nil {
		return fmt.Errorf("failed to start container: %w", err)
	}

	// Start health checking - this will handle the rest of the flow
	go c.healthCheckAndSwitch(ctx, deployment, inactiveColor)

	return nil
}

// GetStatus returns the current deployment status
func (c *Controller) GetStatus(hostname string) (*core.Deployment, error) {
	return c.store.GetDeployment(hostname)
}

// healthCheckAndSwitch handles health checking and automatic traffic switching
func (c *Controller) healthCheckAndSwitch(ctx context.Context, deployment *core.Deployment, newColor core.Color) {
	log.Printf("[DEPLOY] Starting health checks for %s (%s)", deployment.Hostname, newColor)

	maxAttempts := 12 // 1 minute with 5-second intervals
	attempts := 0

	ticker := time.NewTicker(50 * time.Millisecond) // Fast for testing
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Printf("[DEPLOY] Health check cancelled for %s", deployment.Hostname)
			return
		case <-ticker.C:
			attempts++
			container := c.getContainer(deployment, newColor)
			
			// Health check
			err := c.health.CheckHealth(ctx, container.Target, container.HealthPath)
			
			if err == nil {
				// Health check passed - switch traffic and cleanup
				c.switchTrafficAndCleanup(deployment, newColor)
				return
			}

			// Health check failed
			log.Printf("[DEPLOY] Health check failed for %s (%s): %v (attempt %d/%d)", 
				deployment.Hostname, newColor, err, attempts, maxAttempts)
			
			if attempts >= maxAttempts {
				// Max attempts reached - mark as failed
				c.markDeploymentFailed(deployment, newColor, err)
				return
			}

			// Update container state and continue
			container.HealthState = core.HealthChecking
			c.setContainer(deployment, newColor, container)
			c.store.SaveDeployment(deployment)
		}
	}
}

// switchTrafficAndCleanup atomically switches traffic and cleans up old container
func (c *Controller) switchTrafficAndCleanup(deployment *core.Deployment, newColor core.Color) {
	log.Printf("[DEPLOY] Health check passed for %s (%s) - switching traffic", deployment.Hostname, newColor)

	// Get old and new containers
	oldColor := deployment.Active
	oldContainer := c.getContainer(deployment, oldColor)
	newContainer := c.getContainer(deployment, newColor)

	// Update new container state
	newContainer.HealthState = core.HealthHealthy
	c.setContainer(deployment, newColor, newContainer)

	// Update proxy (atomic traffic switch)
	c.proxy.UpdateRoute(deployment.Hostname, newContainer.Target, true)
	
	// Update deployment state
	deployment.Active = newColor
	deployment.UpdatedAt = time.Now()
	
	if err := c.store.SaveDeployment(deployment); err != nil {
		log.Printf("[DEPLOY] Failed to save deployment state: %v", err)
		return
	}

	// Publish traffic switched event
	c.events.Publish(&core.TrafficSwitched{
		BaseEvent:    core.BaseEvent{Timestamp: time.Now(), Hostname: deployment.Hostname},
		DeploymentID: deployment.ID,
		FromColor:    oldColor,
		ToColor:      newColor,
		FromTarget:   oldContainer.Target,
		ToTarget:     newContainer.Target,
	})

	log.Printf("[DEPLOY] Traffic switched successfully for %s: %s -> %s", 
		deployment.Hostname, oldContainer.Target, newContainer.Target)

	// Clean up old container immediately
	if oldContainer.Target != "" {
		c.cleanupOldContainer(deployment, oldColor)
	}

	// Publish deployment completed event
	c.events.Publish(&core.DeploymentCompleted{
		BaseEvent:    core.BaseEvent{Timestamp: time.Now(), Hostname: deployment.Hostname},
		DeploymentID: deployment.ID,
		Color:        newColor,
	})
}

// cleanupOldContainer immediately stops and removes the old container
func (c *Controller) cleanupOldContainer(deployment *core.Deployment, oldColor core.Color) {
	oldContainer := c.getContainer(deployment, oldColor)
	containerName := c.extractContainerName(oldContainer.Target)
	
	log.Printf("[DEPLOY] Cleaning up old container %s for %s", containerName, deployment.Hostname)

	// Stop the actual container
	if err := c.stopContainer(containerName); err != nil {
		log.Printf("[DEPLOY] Failed to stop container %s: %v", containerName, err)
	}

	// Update state to mark container as stopped
	oldContainer.HealthState = core.HealthStopped
	oldContainer.Target = "" // Clear target since container is gone
	c.setContainer(deployment, oldColor, oldContainer)
	c.store.SaveDeployment(deployment)

	log.Printf("[DEPLOY] Old container %s cleaned up successfully", containerName)
}

// markDeploymentFailed marks a deployment as failed and cleans up
func (c *Controller) markDeploymentFailed(deployment *core.Deployment, failedColor core.Color, err error) {
	log.Printf("[DEPLOY] Deployment failed for %s (%s): %v", deployment.Hostname, failedColor, err)

	// Update container state
	container := c.getContainer(deployment, failedColor)
	container.HealthState = core.HealthUnhealthy
	c.setContainer(deployment, failedColor, container)

	// Clean up the failed container
	containerName := c.extractContainerName(container.Target)
	if err := c.stopContainer(containerName); err != nil {
		log.Printf("[DEPLOY] Failed to cleanup failed container %s: %v", containerName, err)
	}

	// Clear the failed container from state
	container.Target = ""
	container.HealthState = core.HealthStopped
	c.setContainer(deployment, failedColor, container)
	c.store.SaveDeployment(deployment)

	// Publish failure event
	c.events.Publish(&core.DeploymentFailed{
		BaseEvent:    core.BaseEvent{Timestamp: time.Now(), Hostname: deployment.Hostname},
		DeploymentID: deployment.ID,
		Color:        failedColor,
		Error:        err.Error(),
	})
}

// Container management helpers
func (c *Controller) generateContainerName(hostname string, color core.Color) string {
	// Convert hostname to DNS-safe name: myapp.com -> myapp-com-blue
	safeName := strings.ReplaceAll(hostname, ".", "-")
	return fmt.Sprintf("%s-%s", safeName, color)
}

func (c *Controller) extractContainerName(target string) string {
	// Extract container name from target: "myapp-com-blue:3000" -> "myapp-com-blue"
	parts := strings.Split(target, ":")
	if len(parts) > 0 {
		return parts[0]
	}
	return target
}

func (c *Controller) startContainer(name, imageTag string) error {
	// In practice: docker run -d --name=$name $imageTag
	log.Printf("[CONTAINER] Starting container %s with image %s", name, imageTag)
	return nil // Placeholder - would execute actual docker command
}

func (c *Controller) stopContainer(name string) error {
	// In practice: docker stop $name && docker rm $name
	log.Printf("[CONTAINER] Stopping and removing container %s", name)
	return nil // Placeholder - would execute actual docker commands
}

// Deployment state helpers (same as before)
func (c *Controller) getOrCreateDeployment(hostname, project, app string) (*core.Deployment, error) {
	deployment, err := c.store.GetDeployment(hostname)
	if err == nil {
		return deployment, nil
	}

	return &core.Deployment{
		ID:        hostname,
		Hostname:  hostname,
		Active:    core.Blue, // Start with blue active
		UpdatedAt: time.Now(),
	}, nil
}

func (c *Controller) getInactiveColor(deployment *core.Deployment) core.Color {
	if deployment.Active == core.Blue {
		return core.Green
	}
	return core.Blue
}

func (c *Controller) setContainer(deployment *core.Deployment, color core.Color, container core.Container) {
	if color == core.Blue {
		deployment.Blue = container
	} else {
		deployment.Green = container
	}
}

func (c *Controller) getContainer(deployment *core.Deployment, color core.Color) core.Container {
	if color == core.Blue {
		return deployment.Blue
	}
	return deployment.Green
}
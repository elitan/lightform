package deployment

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/elitan/lightform/proxy/internal/core"
)

// Controller orchestrates blue-green deployments
type Controller struct {
	store       core.DeploymentStore
	proxy       ProxyUpdater
	health      core.HealthChecker
	events      core.EventBus
}

// ProxyUpdater interface to update proxy routes
type ProxyUpdater interface {
	UpdateRoute(hostname, target string, healthy bool)
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

// Deploy orchestrates a blue-green deployment
func (c *Controller) Deploy(ctx context.Context, hostname, target, project, app string) error {
	log.Printf("[DEPLOY] Starting deployment for %s -> %s", hostname, target)

	// Get or create deployment
	deployment, err := c.getOrCreateDeployment(hostname, project, app)
	if err != nil {
		return fmt.Errorf("failed to get deployment: %w", err)
	}

	// Determine which color to deploy to
	inactiveColor := c.getInactiveColor(deployment)
	
	// Create new container
	newContainer := core.Container{
		ID:          fmt.Sprintf("%s-%s-%d", hostname, inactiveColor, time.Now().Unix()),
		Target:      target,
		HealthPath:  "/health", // TODO: make configurable
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
		Target:       target,
	})

	// Start health checking in background
	go c.healthCheckLoop(ctx, deployment, inactiveColor)

	return nil
}

// GetStatus returns the current deployment status
func (c *Controller) GetStatus(hostname string) (*core.Deployment, error) {
	return c.store.GetDeployment(hostname)
}

// Rollback switches back to the previous color
func (c *Controller) Rollback(ctx context.Context, hostname string) error {
	deployment, err := c.store.GetDeployment(hostname)
	if err != nil {
		return fmt.Errorf("deployment not found: %w", err)
	}

	// Switch to the other color
	newActive := core.Blue
	if deployment.Active == core.Blue {
		newActive = core.Green
	}

	return c.switchTraffic(deployment, newActive)
}

// getOrCreateDeployment gets existing deployment or creates new one
func (c *Controller) getOrCreateDeployment(hostname, project, app string) (*core.Deployment, error) {
	deployment, err := c.store.GetDeployment(hostname)
	if err == nil {
		return deployment, nil
	}

	// Create new deployment
	deployment = &core.Deployment{
		ID:        hostname, // Use hostname as ID for simplicity
		Hostname:  hostname,
		Active:    core.Blue, // Start with blue active
		UpdatedAt: time.Now(),
	}

	return deployment, nil
}

// getInactiveColor returns the color that's not currently active
func (c *Controller) getInactiveColor(deployment *core.Deployment) core.Color {
	if deployment.Active == core.Blue {
		return core.Green
	}
	return core.Blue
}

// setContainer sets the container for the given color
func (c *Controller) setContainer(deployment *core.Deployment, color core.Color, container core.Container) {
	if color == core.Blue {
		deployment.Blue = container
	} else {
		deployment.Green = container
	}
}

// getContainer gets the container for the given color
func (c *Controller) getContainer(deployment *core.Deployment, color core.Color) core.Container {
	if color == core.Blue {
		return deployment.Blue
	}
	return deployment.Green
}

// healthCheckLoop continuously health checks the new container
func (c *Controller) healthCheckLoop(ctx context.Context, deployment *core.Deployment, color core.Color) {
	log.Printf("[DEPLOY] Starting health checks for %s (%s)", deployment.Hostname, color)

	maxAttempts := 3
	attempts := 0

	// Perform initial health check immediately
	if c.performHealthCheck(ctx, deployment, color, &attempts, maxAttempts) {
		return
	}

	// Continue with periodic checks
	ticker := time.NewTicker(100 * time.Millisecond) // Fast for testing
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Printf("[DEPLOY] Health check cancelled for %s", deployment.Hostname)
			return
		case <-ticker.C:
			if c.performHealthCheck(ctx, deployment, color, &attempts, maxAttempts) {
				return // Health check completed (success or failure)
			}
		}
	}
}

func (c *Controller) performHealthCheck(ctx context.Context, deployment *core.Deployment, color core.Color, attempts *int, maxAttempts int) bool {
	*attempts++
	container := c.getContainer(deployment, color)
	
	// Health check
	err := c.health.CheckHealth(ctx, container.Target, container.HealthPath)
	
	if err == nil {
		// Health check passed
		log.Printf("[DEPLOY] Health check passed for %s (%s)", deployment.Hostname, color)
		
		// Update container state
		container.HealthState = core.HealthHealthy
		c.setContainer(deployment, color, container)
		c.store.SaveDeployment(deployment)

		// Publish event
		c.events.Publish(&core.HealthCheckPassed{
			BaseEvent:    core.BaseEvent{Timestamp: time.Now(), Hostname: deployment.Hostname},
			DeploymentID: deployment.ID,
			Color:        color,
		})

		// Switch traffic
		c.switchTraffic(deployment, color)
		return true // Health check completed successfully
	}

	// Health check failed
	log.Printf("[DEPLOY] Health check failed for %s (%s): %v", deployment.Hostname, color, err)
	
	if *attempts >= maxAttempts {
		// Max attempts reached
		log.Printf("[DEPLOY] Health check failed after %d attempts for %s", maxAttempts, deployment.Hostname)
		
		container.HealthState = core.HealthUnhealthy
		c.setContainer(deployment, color, container)
		c.store.SaveDeployment(deployment)

		// Publish failure event
		c.events.Publish(&core.DeploymentFailed{
			BaseEvent:    core.BaseEvent{Timestamp: time.Now(), Hostname: deployment.Hostname},
			DeploymentID: deployment.ID,
			Color:        color,
			Error:        err.Error(),
		})
		return true // Health check completed (failed)
	}

	// Update container state
	container.HealthState = core.HealthChecking
	c.setContainer(deployment, color, container)
	c.store.SaveDeployment(deployment)
	return false // Continue health checking
}

// switchTraffic atomically switches traffic to the given color
func (c *Controller) switchTraffic(deployment *core.Deployment, toColor core.Color) error {
	log.Printf("[DEPLOY] Switching traffic for %s to %s", deployment.Hostname, toColor)

	container := c.getContainer(deployment, toColor)
	
	// Update proxy
	c.proxy.UpdateRoute(deployment.Hostname, container.Target, true)
	
	// Update deployment state
	fromColor := deployment.Active
	deployment.Active = toColor
	deployment.UpdatedAt = time.Now()
	
	if err := c.store.SaveDeployment(deployment); err != nil {
		return fmt.Errorf("failed to save deployment after traffic switch: %w", err)
	}

	// Publish event
	fromContainer := c.getContainer(deployment, fromColor)
	c.events.Publish(&core.TrafficSwitched{
		BaseEvent:    core.BaseEvent{Timestamp: time.Now(), Hostname: deployment.Hostname},
		DeploymentID: deployment.ID,
		FromColor:    fromColor,
		ToColor:      toColor,
		FromTarget:   fromContainer.Target,
		ToTarget:     container.Target,
	})

	log.Printf("[DEPLOY] Traffic switched successfully for %s: %s -> %s", 
		deployment.Hostname, fromContainer.Target, container.Target)

	return nil
}
# Zero-Downtime Deployments

Luma CLI now provides automatic zero-downtime deployments for all applications using a blue-green deployment strategy. This feature works transparently - users deploy as they always have, and the system automatically ensures zero downtime.

## Overview

### What's New

- **Automatic Zero-Downtime**: All app deployments now have zero downtime by default
- **Blue-Green Strategy**: Transparent blue-green deployment happens automatically
- **Multiple Replicas**: Support for deploying multiple replicas with zero downtime
- **Network Alias Switching**: Atomic traffic switching with sub-millisecond downtime
- **Graceful Shutdown**: 30-second graceful shutdown period for in-flight requests
- **Status Monitoring**: New `luma status` command shows deployment state

### Key Benefits

- **Zero Configuration**: No additional setup required
- **Backward Compatible**: Existing configurations work unchanged
- **Transparent**: Users deploy exactly as before (`luma deploy <app>`)
- **Reliable**: Automatic failure handling and rollback
- **Fast**: Efficient deployments with minimal resource overhead

## How It Works

### Blue-Green Deployment Process

1. **Deploy New Version**: Creates new containers with inactive color (blue/green)
2. **Health Check**: Validates all new containers are healthy via `/up` endpoint
3. **Traffic Switch**: Atomically switches network alias to new containers
4. **Graceful Shutdown**: Allows in-flight requests to complete (30s timeout)
5. **Cleanup**: Removes old containers after graceful period

### Container Naming Convention

**Single Replica**:

- Active: `myapp-blue` or `myapp-green`
- Network alias: `myapp` (always points to active color)

**Multiple Replicas**:

- Active: `myapp-blue-1`, `myapp-blue-2`, `myapp-blue-3`
- Network alias: `myapp` (points to all active replicas)

### Request Handling During Deployment

```
Before Deployment:
User Request → luma-proxy → myapp (alias) → myapp-blue → Response

During Deployment:
New Requests → luma-proxy → myapp (alias) → myapp-blue → Response
Old Requests → (continue in myapp-blue)
New Version → myapp-green (health checking)

After Network Switch:
New Requests → luma-proxy → myapp (alias) → myapp-green → Response
Old Requests → (completing in myapp-blue before shutdown)
```

## Configuration

### Basic Configuration

No changes required! Existing configurations work automatically:

```yaml
apps:
  blog:
    image: "my-blog"
    servers: ["server1"]
    proxy:
      hosts: ["blog.com"]
      app_port: 3000
```

### Multiple Replicas

Add the `replicas` field for multiple instances:

```yaml
apps:
  api:
    image: "my-api"
    replicas: 3
    servers: ["server1", "server2"]
    proxy:
      hosts: ["api.com"]
      app_port: 8080
```

### Health Check Configuration

Configure health check timing (optional):

```yaml
apps:
  web:
    image: "my-web"
    health_check:
      start_period: "10s" # Wait time before health checks
      interval: "30s" # Check interval
      timeout: "5s" # Per-check timeout
      retries: 3 # Retry count
```

## Usage

### Deploy with Zero Downtime

Same command as always - zero downtime happens automatically:

```bash
# Deploy single app
luma deploy blog

# Deploy specific apps
luma deploy blog api

# Deploy all apps
luma deploy
```

### Check Deployment Status

New status command shows blue-green deployment state:

```bash
# Check all apps
luma status

# Check specific app
luma status blog
```

Example output:

```
📱 App: blog
   Status: ✅ RUNNING (active: green)
   Replicas: 2/2 running
   Colors: 0 blue, 2 green
   Servers: server1, server2
```

### Monitor During Deployment

Deployment shows progress and health check status:

```bash
$ luma deploy blog
[server1] Deploying blog (2 replicas)...
[server1] Current active: blue, deploying: green
[server1] Deploying 2 replica(s): blog-green-1, blog-green-2
[server1] Creating container blog-green-1...
[server1] Creating container blog-green-2...
[server1] Performing health checks on 2 containers...
[server1] Health check passed for blog-green-1
[server1] Health check passed for blog-green-2
[server1] All 2 containers passed health checks ✓
[server1] Switching traffic to green containers...
[server1] Gracefully shutting down 2 old containers...
[server1] Blue-green deployment completed successfully ✅
```

## Application Requirements

### Health Check Endpoint

Applications must provide a `/up` endpoint that returns 200 OK when healthy:

```javascript
app.get("/up", (req, res) => {
  // Check database connection, dependencies, etc.
  res.status(200).json({ status: "ok" });
});
```

### Graceful Shutdown Handling

Applications should handle SIGTERM for graceful shutdown:

```javascript
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, starting graceful shutdown...");

  // Stop accepting new requests
  server.close(() => {
    // Close database connections
    database.close();

    // Exit process
    process.exit(0);
  });
});
```

## Troubleshooting

### Common Issues

**Health Check Failures**:

```bash
[server] Health check failed for blog-green-1
[server] Cleaning up failed deployment containers...
```

- Ensure `/up` endpoint returns 200 OK
- Check application logs for startup errors
- Verify `app_port` configuration matches application port

**Deployment Timeout**:

```bash
[server] Health check timeout for blog-green-1
```

- Increase `health_check.start_period` if app needs more startup time
- Check if application is binding to correct port
- Verify network connectivity between containers

**Resource Issues**:

```bash
[server] Failed to create container blog-green-1
```

- Ensure sufficient memory/CPU for 2x containers during deployment
- Check Docker daemon status and resources
- Verify image availability and pull permissions

### Status Command Diagnostics

Use status command to diagnose deployment state:

```bash
# Check if app has active containers
luma status myapp

# Example problematic output:
📱 App: myapp
   Status: ⚠️ MIXED (active: blue)
   Replicas: 1/2 running
   Colors: 1 blue, 0 green
```

This indicates a partial deployment that needs investigation.

## Advanced Scenarios

### Long-Running Requests

Requests that exceed the 30-second graceful shutdown period:

- Container shutdown is delayed until request completes
- Very long requests (60+ seconds) may be forcefully terminated
- Consider implementing request timeouts in your application

### WebSocket Connections

Persistent connections are terminated during deployment:

- Implement client-side reconnection logic
- Consider connection draining strategies for critical real-time features

### Database Transactions

Active transactions must complete before container shutdown:

- Implement transaction timeout limits
- Use connection pooling with graceful connection closure
- Consider external session storage for session persistence

## Migration from Previous Deployments

### Automatic Migration

Existing deployments automatically adopt blue-green strategy:

- First deployment after upgrade creates blue containers
- Subsequent deployments alternate between blue and green
- No manual intervention required

### Container Cleanup

Old containers from previous deployment strategies are automatically cleaned up during the first blue-green deployment.

## Technical Implementation

### Network Architecture

- All containers on project-specific network: `{project-name}-network`
- Network alias `{app-name}` routes to active color containers
- luma-proxy uses network aliases for routing (no reconfiguration needed)

### State Management

Container labels track deployment state:

```bash
luma.app=blog          # Application name
luma.color=green       # Container color (blue/green)
luma.replica=1         # Replica index
luma.active=true       # Whether this container is active
```

### Failure Handling

- **Health Check Failure**: Abort deployment, cleanup new containers
- **Network Switch Failure**: Attempt to restore original state
- **Resource Exhaustion**: Clear error reporting with cleanup
- **Automatic Recovery**: No manual intervention required for most failures

---

The zero-downtime deployment system provides reliable, transparent deployments that "just work" without adding complexity to your workflow.

# Zero-Downtime Deployments - Product Requirements Document

## Executive Summary

Luma CLI will provide zero-downtime deployments automatically for all applications. Users simply deploy as they always have, and the system transparently ensures zero downtime using blue-green deployment strategy behind the scenes.

## Problem Statement

**Current State**: Developers experience downtime during deployments, causing service interruptions and poor user experience.

**Target State**: Developers deploy applications with zero downtime automatically, without any additional complexity or configuration required.

## User Personas

### Primary User: Application Developer

- Deploys web applications and APIs to production
- Values simplicity and doesn't want to learn complex deployment strategies
- Wants reliable deployments that "just work"
- Expects zero downtime without additional configuration

### Secondary User: DevOps Engineer

- Manages multiple applications with varying traffic patterns
- Needs reliable, predictable deployments
- Values consistent deployment behavior across all applications
- Wants zero-downtime deployments without operational complexity

## Product Requirements

### 1. Transparent Zero-Downtime Deployments

**Requirement**: All applications deploy with zero downtime automatically, without user configuration or awareness of the underlying strategy.

**User Behavior**:

- User runs `luma deploy <app>` as they always have
- System automatically provides zero downtime regardless of application type
- User sees deployment progress and success/failure
- No additional commands or configuration required

**Success Criteria**:

- Zero downtime for all deployments
- No changes to existing user workflows
- No additional complexity for users
- Reliable deployment behavior across all application types

### 2. Automatic Zero-Downtime Strategy

**Requirement**: The system automatically uses the best deployment strategy to ensure zero downtime.

**User Experience**:

```yaml
# Simple configuration - no deployment strategy needed
apps:
  blog:
    image: "my-blog"
    proxy:
      hosts: ["blog.com"]
      app_port: 3000

  # Multiple replica configuration - same simplicity
  api:
    image: "my-api"
    replicas: 4
    proxy:
      hosts: ["api.com"]
      app_port: 8080
```

**Deployment Flow**:

1. User runs `luma deploy <app>`
2. System automatically ensures zero downtime using optimal strategy
3. User sees deployment progress
4. Application is live with zero downtime
5. No additional steps or commands required

**Success Criteria**:

- Zero packet loss during deployment
- Fast deployment completion
- Automatic failure handling and recovery
- Simple user experience

## Technical Implementation

### Container Naming and Management

**Blue-Green Container Naming Convention**:

- Single replica: `{app-name}-blue` or `{app-name}-green`
- Multiple replicas: `{app-name}-blue-1`, `{app-name}-blue-2`, ..., `{app-name}-blue-N`
- Network alias: Always `{app-name}` (pointing to active color)

**Example Container States**:

```bash
# Current state: Blue active
blog-blue                    # Active container
→ Network alias: blog

# During deployment: Both colors exist
blog-blue                    # Current active
blog-green                   # New version (being deployed)

# After successful deployment: Green active
blog-green                   # New active container
→ Network alias: blog
```

### Network Architecture Integration

**Project Network Management**:

- All containers exist on project-specific network: `{project-name}-network`
- luma-proxy container connected to all project networks
- Network alias `{app-name}` routes to active color containers
- Atomic alias switching ensures zero-downtime transitions

**Network Alias Switching Process**:

1. Deploy new color containers with temporary aliases (`{app-name}-green-temp`)
2. Verify all replicas healthy via luma-proxy health checks
3. Atomically switch network alias from `{app-name}` to point to new color
4. Remove old color containers and temporary aliases

### Proxy Configuration Management

**luma-proxy Integration**:

- Proxy routes based on network aliases, not container names
- No proxy reconfiguration needed during blue-green switch
- Host routing remains stable: `example.com` → `{app-name}:port`
- Network alias switch automatically redirects traffic

**Proxy Configuration Persistence**:

```bash
# Initial configuration (done once)
docker exec luma-proxy luma-proxy deploy \
  --host blog.com \
  --target blog:3000 \
  --project myproject

# Blue-green deployment uses existing configuration
# No proxy reconfiguration required during switch
```

### Health Check System

**Health Check Integration**:

- Uses existing luma-proxy-based health check system
- Validates `/up` endpoint for all new color containers
- Requires all replicas healthy before traffic switch
- Automatic rollback if any health check fails

**Health Check Process**:

```bash
# For each new container replica
docker exec luma-proxy curl -f http://{container-ip}:{app-port}/up

# All replicas must return 200 OK before proceeding
# If any replica fails: abort deployment, cleanup new containers
```

### Replica Management

**Single Replica Deployment**:

1. Determine active color (blue/green)
2. Deploy inactive color container
3. Health check new container
4. Switch network alias to new container
5. Remove old container

**Multiple Replica Deployment**:

1. Determine active color and target replica count
2. Deploy all inactive color replicas simultaneously
3. Health check all new replicas
4. Switch network alias to new replica set
5. Remove all old replicas

### Database State Management

**Container State Tracking**:

```bash
# State stored in container labels
docker container ls --filter "label=luma.app=blog" \
  --format "{{.Names}} {{.Label \"luma.color\"}} {{.Label \"luma.active\"}}"

blog-blue   blue   true
blog-green  green  false
```

**State Transition Management**:

- Active state tracked via container labels
- Color determination based on existing active containers
- Rollback state preserved until next successful deployment

### Error Handling and Rollback

**Deployment Failure Scenarios**:

1. **Health Check Failure**: Stop deployment, cleanup new containers, keep current active
2. **Network Switch Failure**: Attempt to restore original state, report error to user
3. **Container Creation Failure**: Clean up partial deployment, report detailed errors

**Automatic Recovery**:

- System automatically maintains current version if deployment fails
- No manual intervention required for most failure scenarios
- Clear error reporting to help users fix configuration issues

### Configuration Schema Extensions

**New Configuration Options**:

```yaml
apps:
  blog:
    image: "my-blog"
    replicas: 1 # Default: 1 (explicit for clarity)
    proxy:
      hosts: ["blog.com"]
      app_port: 3000
    # No blue-green configuration needed - handled automatically
```

**Backward Compatibility**:

- Existing configurations work without changes
- `replicas` defaults to 1 if not specified
- Zero-downtime strategy applies automatically to all apps

## HTTP Request Handling During Deployment

### Request Flow During Zero-Downtime Deployment

**Normal Request Processing** (before deployment):

```
User Request → luma-proxy → blog (network alias) → blog-blue container → Response
```

**During Deployment** (both versions running):

```
New Requests → luma-proxy → blog (network alias) → blog-blue container → Response
Old Requests → (continue processing in blog-blue)
New Version → blog-green container (being health checked)
```

**After Network Switch** (zero-downtime transition):

```
New Requests → luma-proxy → blog (network alias) → blog-green container → Response
Old Requests → (completing in blog-blue before container shutdown)
```

### Long-Running Request Scenarios

**Scenario 1: 5-Second Request During Deployment**

Timeline:

- `T+0s`: Request arrives at luma-proxy, routed to blog-blue
- `T+1s`: Deployment starts, blog-green container created
- `T+3s`: blog-green passes health checks
- `T+3.1s`: Network alias switches to blog-green
- `T+5s`: Original request completes successfully in blog-blue
- `T+35s`: blog-blue container shuts down after graceful period

**Request Handling**:

1. **In-flight requests continue** on the original container (blog-blue)
2. **New requests immediately** route to the new container (blog-green)
3. **No request interruption** occurs during the switch
4. **Original container waits** for in-flight requests to complete

**Scenario 2: Very Long Request (60+ seconds)**

Timeline:

- Long request starts processing in blog-blue
- Deployment completes, network alias switches to blog-green
- blog-blue enters graceful shutdown period (30 seconds default)
- Long request still processing after 30 seconds

**Behavior**:

- Container shutdown is **delayed** until request completes
- If request exceeds maximum wait time (configurable), container force-stops
- Request may fail if it exceeds the maximum graceful shutdown period

### Graceful Shutdown Requirements for Applications

**SIGTERM Signal Handling** (Required):

Applications must implement proper SIGTERM handling:

```javascript
// Example Node.js implementation
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, starting graceful shutdown...");

  // 1. Stop accepting new requests
  server.close(() => {
    console.log("HTTP server closed");

    // 2. Close database connections
    database.close();

    // 3. Complete any pending work
    // 4. Exit process
    process.exit(0);
  });
});
```

**Required Application Behavior**:

1. **Stop Accepting New Requests**: Immediately stop accepting new HTTP connections
2. **Complete In-Flight Requests**: Allow existing requests to finish processing
3. **Close Resources**: Gracefully close database connections, file handles, etc.
4. **Exit Cleanly**: Exit the process after cleanup is complete

**Graceful Shutdown Phases**:

```
SIGTERM received → Stop new requests → Complete existing requests → Close resources → Exit
```

### Edge Cases and Considerations

**WebSocket and Long-Polling Connections**:

- **Persistent connections** will be terminated during deployment
- Applications should implement **reconnection logic** on the client side
- Consider using **connection draining** strategies for critical real-time features

**Database Transactions**:

- **Active transactions** must complete before container shutdown
- Applications should implement **transaction timeout limits**
- **Connection pooling** should handle graceful connection closure

**File Uploads/Downloads**:

- **Large file transfers** may be interrupted if they exceed graceful shutdown period
- Consider implementing **resumable upload/download** mechanisms
- **Temporary file cleanup** should occur during graceful shutdown

**Session State**:

- **In-memory sessions** will be lost during deployment
- Use **external session storage** (Redis, database) for session persistence
- Implement **stateless authentication** (JWT tokens) where possible

### Deployment Timing Defaults

**Automatic Timeout Handling**:

- Graceful shutdown timeout: **30 seconds** (containers wait this long for graceful shutdown)
- Health check timeout: **10 seconds** per replica
- Network alias switching: **Sub-millisecond** (atomic operation)

**No Configuration Required**: The system uses sensible defaults that work for most applications without requiring user configuration.

### Request Routing Guarantees

**Zero Packet Loss Promise**:

- **No requests are dropped** during deployment
- **In-flight requests complete** on original containers
- **New requests immediately route** to healthy new containers
- **Network alias switching is atomic** (sub-millisecond)

**Failure Handling**:

- If **new container health checks fail**: No traffic switch, old container continues
- If **graceful shutdown times out**: Container force-stops, may interrupt requests
- If **network switch fails**: Attempt to restore original routing, manual intervention may be required

**Monitoring and Observability**:

- **Request completion tracking** during deployments
- **Graceful shutdown duration** metrics
- **Failed request alerting** if deployment causes issues
- **Connection draining** status and progress

## User Workflows

### Workflow 1: Simple Application Deployment

**Scenario**: Developer deploying a blog application

**Steps**:

1. Developer configures application in `luma.yml`
2. Runs `luma deploy blog`
3. System automatically provides zero downtime
4. Developer sees deployment progress and completion
5. Application is live with zero downtime

**Expected Outcome**: Fast, reliable deployment with zero complexity

### Workflow 2: Multiple Replica Application Deployment

**Scenario**: Developer deploying API with 4 replicas

**Steps**:

1. Developer sets `replicas: 4` in configuration
2. Runs `luma deploy api`
3. System automatically handles multiple replicas with zero downtime
4. Developer sees deployment progress and completion
5. API deploys seamlessly with zero downtime

**Expected Outcome**: Smooth deployment with no additional complexity

### Workflow 3: Production Deployment with Failure

**Scenario**: Production deployment that encounters an issue

**Steps**:

1. Developer deploys new version to production
2. System detects health check failure during deployment
3. System automatically maintains current version, reports error
4. Developer fixes issue and redeploys
5. No service disruption occurs

**Expected Outcome**: Automatic failure handling with no service interruption

## System States and Transitions

### Application Deployment States

**Initial State**:

- No containers exist
- First deployment creates containers

**Steady State**:

- N active containers where N = replica count
- Containers serve traffic normally
- Ready for next deployment

**During Deployment**:

- System temporarily runs both old and new versions
- Health checks verify new version works correctly
- Traffic switches to new version only when ready
- Old version automatically cleaned up

**Post-Deployment State**:

- New containers are active and serving traffic
- Old containers are removed
- System ready for next deployment

## User Interface Requirements

### CLI Feedback

**Simple Deployment Communication**:

```bash
$ luma deploy blog
[server] Deploying blog...
[server] Health check: ✓ Healthy
[server] Deployment complete ✅

$ luma deploy api
[server] Deploying api (4 replicas)...
[server] Health checks: ✓ 4/4 replicas healthy
[server] Deployment complete ✅
```

**Progress Indicators**:

- Clear deployment progress messaging
- Health check status
- Deployment completion confirmation
- Error messages when deployment fails

### Status and Monitoring

**Application Status**:

```bash
$ luma status blog
[server] Status: Running
[server] Health: ✓ Healthy
[server] Last deployed: 5 minutes ago

$ luma status api
[server] Status: Running (4 replicas)
[server] Health: ✓ 4/4 replicas healthy
[server] Last deployed: 10 minutes ago
```

## Constraints and Assumptions

### Technical Constraints

- Applications must provide `/up` health check endpoint
- Containers must handle graceful shutdown signals (SIGTERM)
- Network connectivity required between luma-proxy and application containers
- Docker networking must support dynamic alias assignment
- Sufficient system resources to run both old and new containers during deployment

### Operational Constraints

- Zero-downtime deployment requires temporary 2x memory/CPU resources during deployment
- Health check endpoints must respond within configured timeout
- Network switching must be reliable to prevent traffic loss

## Dependencies and Risks

### External Dependencies

- Luma-proxy must support backend routing via network aliases
- Docker engine must support network alias management and atomic updates
- Health check endpoints must be implemented by applications

### Technical Risks

- Network alias switching may cause brief connectivity issues
- Container health check false positives/negatives
- Resource exhaustion during deployment
- Deployment coordination complexity for multiple replica applications

### Mitigation Strategies

- Extensive testing of network alias transitions
- Multiple health check validation methods
- Clear error reporting and automatic recovery procedures
- Resource monitoring and validation before deployment
- Gradual rollout with careful testing

This PRD ensures zero-downtime deployments happen automatically and transparently, providing reliable deployment behavior without adding complexity for users.

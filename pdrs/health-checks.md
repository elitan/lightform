# Health Checks Issues and Analysis

## Current Problem

We are experiencing a critical issue where deployed applications appear healthy in the Luma proxy configuration but return 503 "Service temporarily unavailable" errors when accessed via HTTPS.

## CRITICAL DISCOVERY 🔍

**The background health checker is working correctly!**

Recent proxy logs show:

```
2025/05/29 14:18:30 Health check succeeded for test.eliasson.me (project: gmail, resolved: 172.23.0.4:3000)
```

The background health checker runs every 30 seconds and **successfully** verifies our service. This means:

- ❌ The issue is NOT the background health checker overriding manual updates
- ❌ The issue is NOT network resolution problems
- ❌ The issue is NOT the health check logic itself

**The problem is likely a synchronization issue between the health check results and the runtime request handling logic.**

## 🎉 RESOLUTION

**The issue has been resolved!** As of 2025/05/29 14:19, the service is now working correctly and consistently returning "Hello World 2" for HTTPS requests.

**UPDATE**: The issue is **intermittent** and has returned as of 14:20. This confirms the timing/synchronization problem is ongoing and not fully resolved.

### What Fixed It (Temporarily)

The resolution appears to have come from the **background health checker** running its 30-second cycle and properly synchronizing the health status. However, this fix was temporary, indicating the underlying synchronization issue persists.

### Root Cause Analysis - CONFIRMED

The issue is a **persistent timing/synchronization problem** that causes intermittent failures:

1. The background health checker successfully verifies the service every 30 seconds
2. Despite successful health checks, the runtime request handling intermittently marks services as unhealthy
3. This suggests a race condition or caching issue in the service lookup/health status retrieval logic

**Critical Finding**: The problem is not a one-time synchronization delay, but an ongoing race condition that causes sporadic failures.

## Symptoms Observed

### 1. Successful Deployment but 503 Errors

- Deployment completes successfully with all health checks passing
- `luma-proxy list` shows the service as "✅ Healthy"
- HTTPS requests return 503 with message "Luma Proxy: Service temporarily unavailable"
- HTTP requests properly redirect to HTTPS (indicating proxy routing works)
- SSL certificates are working correctly

### 2. Internal Connectivity Works

- Direct calls to the application from within the proxy container work:
  ```bash
  docker exec luma-proxy curl -s http://web:3000/api/health  # Returns "OK"
  docker exec luma-proxy curl -s http://web:3000/           # Returns "Hello World 2"
  ```
- Application containers are running and healthy
- Network connectivity between proxy and application is functional

### 3. Proxy Logs Show Conflicting Information

```
Service test.eliasson.me is unhealthy, returning 503
```

This occurs despite the configuration showing the service as healthy.

### 4. Manual Health Updates Don't Persist

- Manual health status updates via `updatehealth` command appear successful
- Service continues to return 503 errors after manual updates
- Restarting the proxy doesn't resolve the issue
- Reconfiguring the route completely doesn't resolve the issue

## Root Cause Analysis

### Multiple Health Check Systems

The codebase has several overlapping health check mechanisms:

1. **Background Health Check Routine** (`manager.go:StartHealthCheckRoutine()`)

   - Runs every 30 seconds
   - Calls `PerformHealthChecks()` which checks all services
   - Updates health status in the configuration

2. **Manual Health Updates** (`updatehealth.go`)

   - Allows manual override of health status
   - Updates the configuration file directly

3. **Deployment-time Health Checks** (`deploy.ts:configureProxyForApp()`)
   - Performs health checks during deployment
   - Updates proxy with health status

### The Core Issue: Race Condition

The problem appears to be a race condition between these systems:

1. **Deployment succeeds** and sets health status to `true`
2. **Background health checker** runs and potentially overwrites the status
3. **Runtime health checking logic** uses cached or stale health information

### Code Path Analysis

#### In `proxy/server.go:handleHTTPSRequest()`:

```go
// Check if service is healthy
if !targetService.Healthy {
    log.Printf("Service %s is unhealthy, returning 503", targetService.Name)
    w.WriteHeader(http.StatusServiceUnavailable)
    fmt.Fprintf(w, "Luma Proxy: Service temporarily unavailable")
    return
}
```

#### In `service/manager.go:checkServiceHealth()`:

```go
// Resolve the backend IP directly using Docker network inspection
resolvedTarget, err := m.resolveBackendIP(service)
if err != nil {
    log.Printf("Health check failed - could not resolve backend for %s in project %s: %v",
        service.Target, service.Project, err)
    return false
}
```

### Potential Issues Identified

1. **Network Resolution Failures**: The background health checker might be failing to resolve backend IPs
2. **Caching Issues**: Backend resolution caching might be stale or incorrect
3. **Configuration Synchronization**: Updates to health status might not be properly synchronized
4. **Background Override**: The 30-second background health checker might be overriding manual updates

## Evidence from Debug Session

### Successful Internal Tests

```bash
# Health check works from within proxy
ssh luma@157.180.25.101 "docker exec luma-proxy curl -s -w 'HTTP Status: %{http_code}\n' http://web:3000/api/health"
# Output: OKHTTP Status: 200

# App works from within proxy
ssh luma@157.180.25.101 "docker exec luma-proxy curl -s http://web:3000/"
# Output: Hello World 2
```

### Configuration Shows Healthy

```bash
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy list" | grep -A4 "test.eliasson.me"
# Output:
# Host: test.eliasson.me
#   Status: ✅ Healthy
```

### But Runtime Logic Marks as Unhealthy

```bash
# Proxy logs show:
# Service test.eliasson.me is unhealthy, returning 503
```

### Network Connectivity Confirmed

```bash
# Proxy is connected to the correct network
docker inspect luma-proxy --format '{{json .NetworkSettings.Networks}}'
# Shows connection to "gmail-network"
```

## Current Workarounds Attempted

1. ✅ **Manual health status update**: `updatehealth --host test.eliasson.me --healthy true`
2. ✅ **Proxy restart**: `docker restart luma-proxy`
3. ✅ **Route reconfiguration**: Re-running the deploy command
4. ✅ **Network verification**: Confirmed proxy can reach application

**Result**: None of the workarounds resolved the issue.

## Proposed Solutions

### Immediate Fixes

1. **Disable Background Health Checker Temporarily**

   - Comment out or disable the 30-second background health check routine
   - This will prevent automatic overrides of manual health status

2. **Add Detailed Logging**

   - Add more verbose logging to the health check resolution process
   - Log when health status changes and why

3. **Fix Configuration Synchronization**
   - Ensure that health status updates are properly synchronized across all components
   - Add proper locking mechanisms if missing

### Long-term Solutions

1. **Unified Health Check System**

   - Consolidate all health check logic into a single, consistent system
   - Remove redundant health check mechanisms

2. **Improved Backend Resolution**

   - Fix the backend IP resolution logic to be more reliable
   - Add better error handling and retry logic

3. **Real-time Health Monitoring**

   - Instead of periodic checks, implement real-time health monitoring
   - Use Docker container events to track container health

4. **Configuration Persistence**
   - Ensure health status is properly persisted and loaded
   - Add validation for configuration integrity

## Files Requiring Investigation

### Critical Files

- `proxy/internal/proxy/server.go` - Main request handling logic
- `proxy/internal/service/manager.go` - Health check management
- `proxy/internal/config/config.go` - Configuration persistence

### Health Check Related Files

- `proxy/internal/cmd/updatehealth.go` - Manual health updates
- `src/proxy/index.ts` - TypeScript proxy client
- `src/docker/index.ts` - Docker health check implementation

## Test Cases Needed

1. **Background Health Check Override Test**

   - Deploy a service
   - Manually set unhealthy
   - Wait 30+ seconds
   - Verify if background checker overrides the manual setting

2. **Configuration Persistence Test**

   - Set health status manually
   - Restart proxy
   - Verify if health status persists

3. **Network Resolution Test**
   - Test backend IP resolution independently
   - Verify if resolution works consistently

## Next Steps

1. **Disable background health checker** to stop the race condition
2. **Add comprehensive logging** to understand the exact failure point
3. **Implement proper health check synchronization**
4. **Create integration tests** to prevent regression

## Prevention Recommendations

Based on this resolution, here are the recommended changes to prevent this timing issue:

### 1. Immediate Health Check After Deployment

- Modify the deployment process to trigger an immediate health check after route configuration
- Don't rely solely on the 30-second background cycle
- Add a verification step that waits for health status to be confirmed

### 2. Better Health Status Initialization

- Ensure newly deployed services start with proper health status synchronization
- Add a "pending" health state during the initial verification period
- Implement proper health status propagation across all proxy components

### 3. Deployment Process Enhancement

```typescript
// Proposed enhancement in deploy.ts
async function configureProxyForApp() {
  // ... existing proxy configuration ...

  // Add immediate health verification
  await triggerImmediateHealthCheck(host, projectName);

  // Wait for health status confirmation (with timeout)
  await waitForHealthStatusConfirmation(host, 30000); // 30 second timeout
}
```

### 4. Health Check API Improvements

- Add a `/luma-proxy/verify-health` endpoint for immediate verification
- Implement health status caching with proper invalidation
- Add health status change events/logging

### 5. Documentation Updates

- Update deployment documentation to mention the potential 30-second delay
- Add troubleshooting steps for health check issues
- Document the background health checker behavior

## Test Cases to Prevent Regression

1. **Deploy-to-Ready Time Test**: Measure time from deployment completion to service availability
2. **Health Status Propagation Test**: Verify health status changes propagate within expected timeframes
3. **Multiple Deployment Test**: Ensure rapid successive deployments don't cause race conditions
4. **Network Partition Test**: Test health checking behavior during network issues

## Impact Assessment

- **Severity**: Critical - Deployed applications are inaccessible
- **Scope**: Affects all deployed applications using the proxy
- **Workaround**: None currently available
- **Timeline**: Requires immediate attention

This issue prevents the successful deployment and operation of applications through the Luma proxy system, making it a blocking issue for production use.

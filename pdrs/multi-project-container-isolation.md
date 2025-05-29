# PRD: Multi-Project Container Isolation

## Problem Statement

Luma cannot deploy two different projects to the same server if both projects have containers with the same name (e.g., "web"). This prevents multi-project deployments on shared infrastructure.

## Current Issue

When deploying multiple projects with shared app names, container conflicts occur because Luma's blue-green deployment system queries containers globally instead of per-project.

### Example Scenario

```yaml
# Project A (examples/basic)
apps:
  web:
    image: nginx

# Project B (examples/nextjs)
apps:
  web:
    image: nextjs-app
```

**Expected**: Both projects run independently on the same server  
**Actual**: Deployments interfere with each other, causing container removal conflicts

You can reproduce this by attempting to deploy both the `examples/basic` and `examples/nextjs` projects to the same server - they both define a `web` app and will conflict.

## Root Cause Analysis

The fundamental issue has two parts:

### 1. Health Check System Problems

- **Current approach**: Groups services by target (`web:3000`) instead of checking each service individually
- **Problem**: Multiple projects with `web:3000` cause health checks to use wrong project context
- **Result**: Health checks fail because they try to resolve `web:3000` in the wrong Docker network

### 2. DNS Namespace Collisions

- **Current approach**: `luma-proxy` connects to all project networks simultaneously
- **Problem**: When resolving `web:3000`, Docker doesn't know which network's "web" to use
- **Result**: Unpredictable routing and health check failures

## Proposed Solution: Network-Aware Routing with Docker Load Balancing

### Architecture Overview

```
luma-proxy ──┬── gmail-network (web:3000 → gmail containers)
             └── nextjs-network (web:3000 → nextjs containers)
```

**Key Insight**: Instead of resolving to IP addresses, use Docker's network-scoped DNS resolution and built-in load balancing.

### Solution Components

#### 1. Network-Aware Service Resolution

Replace global DNS resolution with project-scoped resolution:

```go
// Instead of: resolveBackendIP() → "172.23.0.5:3000"
// Use: resolveServiceInNetwork() → "web:3000" within project context

func (s *Server) routeToProjectService(service models.Service, request *http.Request) {
    // Ensure we're routing within the correct project network context
    networkContext := fmt.Sprintf("%s-network", service.Project)

    // Use Docker's built-in service discovery within the project network
    // Docker automatically load balances between containers with the same alias
    targetURL := fmt.Sprintf("http://%s", service.Target) // "web:3000"

    // Route request using network-scoped DNS resolution
    s.proxyToTargetInNetwork(request, targetURL, networkContext)
}
```

#### 2. Strategic Network Alias Management

Use Docker network aliases for blue-green deployments and replicas:

```bash
# During blue-green deployment in gmail project:

# Step 1: Green deployment (new version)
docker run --name gmail-web-green --network gmail-network --network-alias web-green ...

# Step 2: Health check green version
curl http://web-green:3000/api/health  # Test new version

# Step 3: Traffic switch (atomic operation)
docker network disconnect gmail-network gmail-web-blue
docker network connect gmail-network gmail-web-green --alias web
# Now "web:3000" points to green, Docker handles the switch

# Step 4: Cleanup
docker rm gmail-web-blue
```

#### 3. Multiple Replica Support

Docker automatically load balances between containers with the same alias:

```bash
# Deploy 4 replicas of web service
docker run --name gmail-web-1 --network gmail-network --network-alias web ...
docker run --name gmail-web-2 --network gmail-network --network-alias web ...
docker run --name gmail-web-3 --network gmail-network --network-alias web ...
docker run --name gmail-web-4 --network gmail-network --network-alias web ...

# Requests to "web:3000" automatically load balance across all 4 containers
```

#### 4. Project-Isolated Health Checks

```go
func (m *Manager) checkServiceHealthInProject(service models.Service) bool {
    // Execute health check within specific project network context
    cmd := exec.Command("docker", "exec", "luma-proxy",
        "sh", "-c",
        fmt.Sprintf("curl -s -f --max-time 5 http://%s%s",
            service.Target,    // "web:3000"
            service.HealthPath // "/api/health"
        ))

    // Set network context to ensure correct DNS resolution
    cmd.Env = append(cmd.Env, fmt.Sprintf("DOCKER_NETWORK_SCOPE=%s-network", service.Project))

    return cmd.Run() == nil
}
```

### Implementation Strategy

#### Phase 1: Fix Health Check Isolation

1. **Modify health check logic** to check each service individually with project context
2. **Remove service grouping by target** that causes cross-project interference
3. **Add network-scoped health checks** that resolve within correct project network

#### Phase 2: Implement Network-Aware Routing

1. **Replace IP-based routing** with network-scoped DNS resolution
2. **Use Docker's service discovery** within each project network
3. **Leverage Docker's load balancing** for multiple containers with same alias

#### Phase 3: Enhanced Blue-Green Deployments

1. **Atomic alias switching** using Docker network commands
2. **Support for replica sets** with automatic load balancing
3. **Graceful traffic migration** during deployments

### Benefits

#### ✅ **True Multi-Project Isolation**

- Each project's `web:3000` resolves independently
- No cross-project interference in health checks or routing
- Projects can use identical service names without conflicts

#### ✅ **Docker-Native Load Balancing**

- Multiple replicas automatically load balanced by Docker
- No custom load balancing logic needed
- Built-in health check integration

#### ✅ **Zero-Downtime Blue-Green Deployments**

- Atomic traffic switching using network alias changes
- Multiple versions can coexist during deployment
- Docker handles the traffic cutover seamlessly

#### ✅ **Scalability**

- Support for horizontal scaling (multiple replicas)
- Docker's built-in service mesh capabilities
- No single-container limitation

### Example: Complete Multi-Project Deployment

```bash
# Deploy Project A (gmail)
cd examples/basic
luma deploy --force
# → Creates gmail-web-green in gmail-network with alias "web"
# → Health checks: http://web:3000/api/health within gmail-network
# → Routing: test.eliasson.me → gmail-network:web:3000

# Deploy Project B (nextjs)
cd examples/nextjs
luma deploy --force
# → Creates nextjs-web-green in nextjs-network with alias "web"
# → Health checks: http://web:3000 within nextjs-network
# → Routing: nextjs.example.com → nextjs-network:web:3000

# Both projects work independently:
curl https://test.eliasson.me      # → gmail app
curl https://nextjs.example.com    # → nextjs app
```

### Migration Path

This solution leverages Docker's native networking and service discovery capabilities while maintaining true project isolation, enabling reliable multi-project deployments on shared infrastructure.

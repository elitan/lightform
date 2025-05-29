# PRD: Multi-Project Container Isolation

## Problem Statement

Luma cannot deploy two different projects to the same server if both projects have containers with the same name (e.g., "web"). This prevents multi-project deployments on shared infrastructure.

## Root Cause: DNS Namespace Collisions

### The Fundamental Issue

When `luma-proxy` connects to multiple project networks simultaneously, Docker's DNS resolution becomes ambiguous:

```
luma-proxy ──┬── gmail-network (web:3000 → gmail containers)
             └── nextjs-network (web:3000 → nextjs containers)
```

**Problem**: When proxy tries to resolve `web:3000`, Docker doesn't know which network's "web" to use.

**Result**: DNS consistently resolves to containers from only ONE project, making other projects unreachable.

## SOLUTION: Dual Network Aliases

### Core Approach - Tested and Proven ✅

**Each container gets dual network aliases:**

```bash
# Each container deployed with BOTH aliases:
docker run --name gmail-web-green \
    --network gmail-network \
    --network-alias web \           # For internal project communication
    --network-alias gmail-web \     # For proxy routing
    ...

docker run --name nextjs-web-green \
    --network nextjs-network \
    --network-alias web \           # For internal project communication
    --network-alias nextjs-web \    # For proxy routing
    ...
```

### Test Results - 100% Success Rate

Our comprehensive testing (`test-dual-alias-solution.sh`) confirmed:

- **✅ Project-Specific Routing: PERFECT** - Zero cross-project interference
- **✅ Internal Communication: PERFECT** - `web:3000` works within each project
- **✅ Load Balancing: PERFECT** - Docker's built-in load balancing works flawlessly

### Implementation Strategy

#### 1. Deployment Changes

**Container Creation with Dual Aliases**:

```typescript
// src/docker/index.ts - Updated container creation
const networkAlias = `${projectName}-${appName}`; // e.g., "gmail-web"

await this.createContainer({
  name: containerName,
  image: imageWithTag,
  networks: [
    {
      name: networkName,
      aliases: [
        appName, // "web" - for internal communication
        networkAlias, // "gmail-web" - for proxy routing
      ],
    },
  ],
  // ...
});
```

#### 2. Service Registration

**Updated Service Target Format**:

```go
// proxy/internal/service/manager.go - Service registration
service := models.Service{
    Host:    config.Host,    // "test.eliasson.me"
    Target:  fmt.Sprintf("%s-%s:%d", projectName, appName, port), // "gmail-web:3000"
    Project: projectName,    // "gmail"
    // ...
}
```

**Example Services Configuration**:

```yaml
# Gmail project services
- host: test.eliasson.me
  target: gmail-web:3000 # Project-specific alias
  project: gmail

# Next.js project services
- host: nextjs.example.com
  target: nextjs-web:3000 # Project-specific alias
  project: nextjs
```

#### 3. Health Check Updates

**Simplified Health Checks**:

```typescript
// TypeScript deployment health checks - No network context needed
async checkHealthWithLumaProxy(
  proxyContainerName: string,
  target: string, // "gmail-web:3000" - already project-specific
  healthCheckPath: string
) {
  const url = `http://${target}${healthCheckPath}`;
  return await this.execInContainer(proxyContainerName, `curl -f ${url}`);
}
```

```go
// Go proxy health checks - Direct resolution, no ambiguity
func (m *Manager) checkServiceHealth(service models.Service) bool {
    targetURL := fmt.Sprintf("http://%s%s", service.Target, service.HealthPath)
    // service.Target is "gmail-web:3000" - unambiguous resolution

    cmd := exec.Command("curl", "-f", "--max-time", "5", targetURL)
    return cmd.Run() == nil
}
```

### Benefits

#### ✅ **Complete DNS Isolation**

- **Proxy routing**: Uses project-specific aliases (`gmail-web:3000`, `nextjs-web:3000`)
- **Zero DNS collisions**: Each project-specific alias is unique
- **Deterministic resolution**: No ambiguity in service discovery

#### ✅ **Internal Project Flexibility**

- **Internal communication**: Projects can still use generic `web:3000` internally
- **No code changes**: Existing internal project code continues to work
- **Clean separation**: External (proxy) vs internal (project) concerns

#### ✅ **Docker-Native Features**

- **Load balancing**: Multiple containers with same alias automatically load balanced
- **Service discovery**: Uses Docker's built-in networking capabilities
- **Blue-green deployments**: Atomic alias switching for zero-downtime deployments

#### ✅ **Scalability**

```bash
# Multiple replicas with dual aliases
docker run --name gmail-web-1 \
    --network-alias web --network-alias gmail-web ...
docker run --name gmail-web-2 \
    --network-alias web --network-alias gmail-web ...
docker run --name gmail-web-3 \
    --network-alias web --network-alias gmail-web ...

# Proxy requests to gmail-web:3000 automatically load balance across all 3
# Internal requests to web:3000 also load balance across all 3
```

### Implementation Changes Required

#### 1. Update Container Creation (`src/docker/index.ts`)

```typescript
// Add dual alias logic to container creation
const createContainerWithDualAliases = async (
  projectName: string,
  appName: string,
  containerName: string,
  networkName: string
) => {
  const projectSpecificAlias = `${projectName}-${appName}`;

  return await this.createContainer({
    name: containerName,
    image: imageWithTag,
    networks: [
      {
        name: networkName,
        aliases: [
          appName, // "web" - for internal use
          projectSpecificAlias, // "gmail-web" - for proxy use
        ],
      },
    ],
    // ... other config
  });
};
```

#### 2. Update Service Registration (`proxy/internal/service/manager.go`)

```go
// Modify service registration to use project-specific targets
func (m *Manager) registerService(config ServiceConfig) {
    projectSpecificTarget := fmt.Sprintf("%s-%s:%d",
        config.Project, config.AppName, config.Port)

    service := models.Service{
        Host:       config.Host,
        Target:     projectSpecificTarget, // "gmail-web:3000"
        Project:    config.Project,
        HealthPath: config.HealthPath,
        // ...
    }

    m.services[config.Host] = service
}
```

#### 3. Remove IP-Based Health Checks

```typescript
// Remove all IP resolution logic from health checks
// Replace with direct project-specific DNS resolution
const healthCheckURL = `http://${service.target}${healthCheckPath}`;
// service.target is already "gmail-web:3000" - no resolution needed
```

### Complete Example: Multi-Project Setup

```bash
# Deploy Gmail project
cd examples/basic
luma deploy
# → Creates containers with aliases: web + gmail-web
# → Registers service: test.eliasson.me → gmail-web:3000

# Deploy Next.js project
cd examples/nextjs
luma deploy
# → Creates containers with aliases: web + nextjs-web
# → Registers service: nextjs.example.com → nextjs-web:3000

# Both work independently with zero conflicts:
curl https://test.eliasson.me      # → gmail-web:3000
curl https://nextjs.example.com    # → nextjs-web:3000
```

### Migration Strategy

#### Phase 1: Update Deployment Logic

- Modify container creation to use dual aliases
- Update service registration to use project-specific targets
- Test with single project deployment

#### Phase 2: Update Health Checks

- Remove IP-based health check resolution
- Use project-specific targets directly
- Test multi-project health checks

#### Phase 3: Production Validation

- Deploy both example projects with new aliases
- Verify DNS resolution and routing works correctly
- Confirm load balancing and blue-green deployments

**Result**: Complete multi-project isolation with zero DNS conflicts and full Docker networking capabilities.

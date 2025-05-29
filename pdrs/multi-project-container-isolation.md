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

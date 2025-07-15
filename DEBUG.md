# Lightform - Debugging Guide

**⚠️ IMPORTANT: Always use Let's Encrypt staging mode for testing to avoid rate limits.**

## Example Applications

- **Basic Go App** (`examples/basic/`): Project name `gmail`, domain `test.eliasson.me`
- **Next.js App** (`examples/nextjs/`): Project name `lightform-example-nextjs`, domain `nextjs.example.mylightform.cloud`

## Quick Commands

### Deploy

```bash
cd examples/basic  # or examples/nextjs

# Deploy (setup is automatic)
bun ../../packages/cli/src/index.ts

# Enable staging mode immediately after first deployment
ssh lightform@157.180.47.213 "docker exec lightform-proxy /usr/local/bin/lightform-proxy set-staging --enabled true"
```

### Server Info

- **Server IP**: `157.180.47.213`
- **SSH Username**: `lightform`

## Proxy Management

### Update Proxy

```bash
cd packages/proxy
./publish.sh

# Infrastructure setup is automatic during deployment - proxy will be updated
bun ../../packages/cli/src/index.ts --verbose

# Manual approach if needed (usually not required):
# Stop and remove proxy container
# ssh lightform@157.180.47.213 "docker stop lightform-proxy && docker rm lightform-proxy"
# Force pull latest image
# ssh lightform@157.180.47.213 "docker pull elitan/lightform-proxy:latest"
```

### Clear Proxy State (.lightform directory)

The `.lightform` directory stores proxy state and is owned by root. **Only the user can delete it.**

**When needed:** Ask user to delete `.lightform` directory and wait for confirmation, then verify deletion.

```bash
# After user confirms deletion, verify it was removed
ssh lightform@157.180.47.213 "ls -la .lightform 2>/dev/null || echo '.lightform directory not found (successfully deleted)'"
```

### Proxy Commands

```bash
# Check status and routes
ssh lightform@157.180.47.213 "docker exec lightform-proxy /usr/local/bin/lightform-proxy list"

# View logs
ssh lightform@157.180.47.213 "docker logs --tail 50 lightform-proxy"

# Enable staging mode (essential for testing)
ssh lightform@157.180.47.213 "docker exec lightform-proxy /usr/local/bin/lightform-proxy set-staging --enabled true"

# Check certificate status
ssh lightform@157.180.47.213 "docker exec lightform-proxy /usr/local/bin/lightform-proxy cert-status"
```

## HTTP API Debugging

The proxy uses HTTP API on localhost:8080 for CLI communication:

```bash
# List all hosts
ssh lightform@157.180.47.213 "docker exec lightform-proxy curl -s localhost:8080/api/hosts"

# Check status
ssh lightform@157.180.47.213 "docker exec lightform-proxy curl -s localhost:8080/api/status"

# Manual deploy
ssh lightform@157.180.47.213 "docker exec lightform-proxy curl -X POST localhost:8080/api/deploy -H 'Content-Type: application/json' -d '{\"host\":\"test.com\",\"target\":\"app:3000\",\"project\":\"test\",\"ssl\":true}'"
```

## SSL Certificate Testing

### Enable Staging Mode (Critical)

```bash
# Always enable for testing
ssh lightform@157.180.47.213 "docker exec lightform-proxy /usr/local/bin/lightform-proxy set-staging --enabled true"

# Test SSL (ignore staging warnings)
curl -k -I https://test.eliasson.me
```

### Clear Certificate State

```bash
# For fresh testing
ssh lightform@157.180.47.213 "docker exec lightform-proxy rm -rf /var/lib/lightform-proxy/certs/*"
ssh lightform@157.180.47.213 "docker exec lightform-proxy rm -f /var/lib/lightform-proxy/state.json"
ssh lightform@157.180.47.213 "docker restart lightform-proxy"
```

## Container Debugging

```bash
# Check project containers
ssh lightform@157.180.47.213 "docker ps --filter 'label=lightform.project=<project-name>'"

# View container logs
ssh lightform@157.180.47.213 "docker logs --tail 50 <container-name>"

# Test internal connectivity
ssh lightform@157.180.47.213 "docker exec lightform-proxy curl -s http://<project-name>-web:3000/"
```

## Cleanup Commands

```bash
# Remove project containers
ssh lightform@157.180.47.213 "docker ps -a --filter 'label=lightform.project=<project-name>' --format '{{.Names}}' | xargs docker rm -f"

# Full cleanup
ssh lightform@157.180.47.213 "docker ps -a --filter 'label=lightform.project' --format '{{.Names}}' | xargs docker rm -f"
```

## Complete Testing Workflow

```bash
# 1. Complete cleanup
ssh lightform@157.180.47.213 "docker stop \$(docker ps -aq) 2>/dev/null || true && docker rm \$(docker ps -aq) 2>/dev/null || true && docker system prune -af --volumes"
ssh lightform@157.180.47.213 "rm -rf ./.lightform"

# 2. Deploy (setup is automatic)
cd examples/basic
bun ../../packages/cli/src/index.ts --verbose
ssh lightform@157.180.47.213 "docker exec lightform-proxy /usr/local/bin/lightform-proxy set-staging --enabled true"

# 3. Test
curl -k -I https://test.eliasson.me
```

## 🔄 **ITERATIVE DEBUGGING METHODOLOGY**

When troubleshooting Lightform issues, follow this systematic feedback loop:

### Debugging Feedback Loop

1. **Test deploy** the basic example project
2. **Check the logs** on the server to see what's happening
3. **Understand the problem** from the log output
4. **Update the code** (proxy or CLI) based on findings
5. **Redeploy** the updated code
6. **Start over again** - repeat until working

### Example Workflow

```bash
# 1. Test deploy (setup is automatic)
cd examples/basic
bun ../../packages/cli/src/index.ts --verbose

# 2. Check the logs
ssh lightform@157.180.47.213 "docker logs --tail 50 lightform-proxy"
ssh lightform@157.180.47.213 "docker logs --tail 30 gmail-web"

# 3. Understand the problem
# - Are there error messages?
# - Is staging mode enabled?
# - Are certificates being acquired?
# - Are containers running?

# 4. Update the code
# - Edit proxy source code if needed
# - Update CLI logic if needed

# 5. Redeploy
cd packages/proxy && ./publish.sh && cd ../../examples/basic  # If proxy changes
bun ../../packages/cli/src/index.ts --verbose                   # Deploy (auto-setup included)

# 6. Start over
# Go back to step 2 and check logs again
```

### Debugging Best Practices

- **Always use staging mode** for SSL testing to avoid rate limits
- **Check logs immediately** after each test
- **Make incremental changes** - fix one issue at a time
- **Test end-to-end** after each fix to ensure no regressions

### Common Debugging Patterns

```bash
# SSL issues - check certificate logs
ssh lightform@157.180.47.213 "docker logs --tail 100 lightform-proxy | grep -E 'CERT|ACME|SSL'"

# Proxy routing issues - check API logs
ssh lightform@157.180.47.213 "docker logs --tail 50 lightform-proxy | grep -E 'PROXY|API'"

# Container health issues - check container status
ssh lightform@157.180.47.213 "docker ps --filter 'label=lightform.project=gmail'"
ssh lightform@157.180.47.213 "docker logs --tail 30 gmail-web"
```

This iterative approach helps systematically identify and fix issues without getting stuck on assumptions.

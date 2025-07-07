# Luma - Debugging Guide

**⚠️ IMPORTANT: Always use Let's Encrypt staging mode for testing to avoid rate limits.**

## Example Applications

- **Basic Go App** (`examples/basic/`): Project name `gmail`, domain `test.eliasson.me`
- **Next.js App** (`examples/nextjs/`): Project name `luma-example-nextjs`, domain `nextjs.example.myluma.cloud`

## Quick Commands

### Deploy

```bash
cd examples/basic  # or examples/nextjs

# Deploy with force flag
bun ../../src/index.ts deploy --force

# Enable staging mode immediately after setup
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"
```

### Server Info

- **Server IP**: `157.180.47.213`
- **SSH Username**: `luma`

## Proxy Management

### Update Proxy

```bash
cd proxy
./publish.sh

# Setup will automatically pull latest proxy if available and start it
bun ../../src/index.ts setup --verbose

# Manual approach if needed (usually not required):
# Stop and remove proxy container
# ssh luma@157.180.25.101 "docker stop luma-proxy && docker rm luma-proxy"
# Force pull latest image
# ssh luma@157.180.25.101 "docker pull elitan/luma-proxy:latest"
```

### Clear Proxy State (.luma directory)

The `.luma` directory stores proxy state and is owned by root. **Only the user can delete it.**

**When needed:** Ask user to delete `.luma` directory and wait for confirmation, then verify deletion.

```bash
# After user confirms deletion, verify it was removed
ssh luma@157.180.25.101 "ls -la .luma 2>/dev/null || echo '.luma directory not found (successfully deleted)'"
```

### Proxy Commands

```bash
# Check status and routes
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy list"

# View logs
ssh luma@157.180.25.101 "docker logs --tail 50 luma-proxy"

# Enable staging mode (essential for testing)
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"

# Check certificate status
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy cert-status"
```

## HTTP API Debugging

The proxy uses HTTP API on localhost:8080 for CLI communication:

```bash
# List all hosts
ssh luma@157.180.25.101 "docker exec luma-proxy curl -s localhost:8080/api/hosts"

# Check status
ssh luma@157.180.25.101 "docker exec luma-proxy curl -s localhost:8080/api/status"

# Manual deploy
ssh luma@157.180.25.101 "docker exec luma-proxy curl -X POST localhost:8080/api/deploy -H 'Content-Type: application/json' -d '{\"host\":\"test.com\",\"target\":\"app:3000\",\"project\":\"test\",\"ssl\":true}'"
```

## SSL Certificate Testing

### Enable Staging Mode (Critical)

```bash
# Always enable for testing
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"

# Test SSL (ignore staging warnings)
curl -k -I https://test.eliasson.me
```

### Clear Certificate State

```bash
# For fresh testing
ssh luma@157.180.25.101 "docker exec luma-proxy rm -rf /var/lib/luma-proxy/certs/*"
ssh luma@157.180.25.101 "docker exec luma-proxy rm -f /var/lib/luma-proxy/state.json"
ssh luma@157.180.25.101 "docker restart luma-proxy"
```

## Container Debugging

```bash
# Check project containers
ssh luma@157.180.25.101 "docker ps --filter 'label=luma.project=<project-name>'"

# View container logs
ssh luma@157.180.25.101 "docker logs --tail 50 <container-name>"

# Test internal connectivity
ssh luma@157.180.25.101 "docker exec luma-proxy curl -s http://<project-name>-web:3000/"
```

## Cleanup Commands

```bash
# Remove project containers
ssh luma@157.180.25.101 "docker ps -a --filter 'label=luma.project=<project-name>' --format '{{.Names}}' | xargs docker rm -f"

# Full cleanup
ssh luma@157.180.25.101 "docker ps -a --filter 'label=luma.project' --format '{{.Names}}' | xargs docker rm -f"
```

## Complete Testing Workflow

```bash
# 1. Complete cleanup
ssh luma@157.180.25.101 "docker stop \$(docker ps -aq) 2>/dev/null || true && docker rm \$(docker ps -aq) 2>/dev/null || true && docker system prune -af --volumes"
ssh luma@157.180.25.101 "rm -rf ./.luma"

# 2. Setup and deploy
cd examples/basic
bun ../../src/index.ts setup --verbose
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"
bun ../../src/index.ts deploy --force

# 3. Test
curl -k -I https://test.eliasson.me
```

## 🔄 **ITERATIVE DEBUGGING METHODOLOGY**

When troubleshooting Luma issues, follow this systematic feedback loop:

### Debugging Feedback Loop

1. **Test deploy** the basic example project
2. **Check the logs** on the server to see what's happening
3. **Understand the problem** from the log output
4. **Update the code** (proxy or CLI) based on findings
5. **Redeploy** the updated code
6. **Start over again** - repeat until working

### Example Workflow

```bash
# 1. Test deploy
cd examples/basic
bun ../../src/index.ts deploy --force --verbose

# 2. Check the logs
ssh luma@157.180.25.101 "docker logs --tail 50 luma-proxy"
ssh luma@157.180.25.101 "docker logs --tail 30 gmail-web"

# 3. Understand the problem
# - Are there error messages?
# - Is staging mode enabled?
# - Are certificates being acquired?
# - Are containers running?

# 4. Update the code
# - Edit proxy source code if needed
# - Update CLI logic if needed

# 5. Redeploy
cd proxy && ./publish.sh && cd ../examples/basic  # If proxy changes
bun ../../src/index.ts setup --verbose            # Automatically pulls updated proxy and starts it
bun ../../src/index.ts deploy --force --verbose   # Deploy again

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
ssh luma@157.180.25.101 "docker logs --tail 100 luma-proxy | grep -E 'CERT|ACME|SSL'"

# Proxy routing issues - check API logs
ssh luma@157.180.25.101 "docker logs --tail 50 luma-proxy | grep -E 'PROXY|API'"

# Container health issues - check container status
ssh luma@157.180.25.101 "docker ps --filter 'label=luma.project=gmail'"
ssh luma@157.180.25.101 "docker logs --tail 30 gmail-web"
```

This iterative approach helps systematically identify and fix issues without getting stuck on assumptions.

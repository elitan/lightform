# Luma - Debugging Guide

This guide helps you debug and verify that Luma works across different example applications and configurations.

## Example Applications

Luma includes two example applications for testing:

### 1. Basic Go App (`examples/basic/`)

- **Language**: Go
- **Project Name**: `gmail` (as defined in `luma.yml`)
- **Features**:
  - Simple Go web server
  - PostgreSQL database service
  - Health check endpoint
  - Environment variables (plain and secret)
- **Domain**: `test.eliasson.me`
- **Ports**: App on 3000, Database on 5433

### 2. Next.js App (`examples/nextjs/`)

- **Language**: Next.js/React
- **Project Name**: `luma-example-nextjs`
- **Features**:
  - Modern React application
  - Production-ready Next.js setup
  - Automatic static optimization
- **Domain**: `nextjs.example.myluma.cloud`
- **Port**: App on 3000

## Quick Start Commands

### Deploy Commands

```bash
# From any example directory
cd examples/basic  # or examples/nextjs

# Deploy with force flag (skips git commit check)
bun ../../src/index.ts deploy --force

# Deploy with verbose output
bun ../../src/index.ts deploy --force --verbose

# Deploy only services (e.g., database for basic example)
bun ../../src/index.ts deploy --services --force

# Deploy only apps (skip services)
bun ../../src/index.ts deploy --apps --force
```

### Server Information

- **Server IP**: `157.180.25.101`
- **SSH Username**: `luma`

## Proxy Management

Luma includes a proxy server located in the `proxy/` directory that handles routing and SSL certificates.

**Note**: The proxy was completely rewritten from scratch based on the architecture specification in `pdrs/proxy.md`. It now uses a pure Go implementation with ACME client for Let's Encrypt integration, JSON state persistence, and background workers for certificate management.

### Proxy Overview

- **Image**: `elitan/luma-proxy`
- **Features**:
  - HTTP to HTTPS redirection
  - Host-based routing
  - Automatic Let's Encrypt certificates via ACME protocol
  - Multi-project isolation
  - State persistence in JSON format
  - Background certificate acquisition and renewal workers

### Updating the Proxy

When you need to modify the proxy:

1. **Make changes** to the proxy source code
2. **Publish** the updated proxy:
   ```bash
   cd proxy
   ./publish.sh
   ```
3. **Stop the proxy** on the server:
   ```bash
   ssh luma@157.180.25.101 "docker stop luma-proxy"
   ```
4. **Pull the updated image** and restart:
   ```bash
   ssh luma@157.180.25.101 "docker pull elitan/luma-proxy:latest && docker start luma-proxy"
   ```

### Proxy Debugging

```bash
# Check proxy status
ssh luma@157.180.25.101 "docker ps --filter 'name=luma-proxy'"

# View proxy logs
ssh luma@157.180.25.101 "docker logs --tail 50 luma-proxy"

# Check proxy configuration and routes
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy list"

# Check proxy status (alias for list)
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy status"

# Test proxy health (if you have a route configured)
curl -I https://test.eliasson.me
```

## Configuration Patterns

### Apps (for building local applications)

```yaml
apps:
  web:
    servers: [...]
    build: # Use build: for local apps
      context: . # Defaults to .
      dockerfile: Dockerfile # Defaults to Dockerfile
      # Platform builds for linux/amd64,linux/arm64 by default
    proxy:
      hosts: [...]
```

### Services (for existing Docker images)

```yaml
services:
  db:
    image: postgres:17 # Use image: for existing images
    servers: [...]
    ports: [...]
```

### Build Features

- **Multi-platform builds**: Automatically builds for `linux/amd64` and `linux/arm64`
- **Smart defaults**: Uses `context: .` and `dockerfile: Dockerfile` if not specified
- **Flexible configuration**: Specify either `image:` OR `build:`, not both

## General Debugging Commands

### Local Development

```bash
# Check available commands and flags
bun src/index.ts

# Check deployment status
bun src/index.ts status

# Setup server infrastructure
bun src/index.ts setup
```

### Remote Server Inspection

Replace `<project-name>` with `gmail` (basic) or `luma-example-nextjs` (nextjs):

```bash
# Check running project containers
ssh luma@157.180.25.101 "docker ps --filter 'label=luma.project=<project-name>'"

# Check all project containers (including stopped)
ssh luma@157.180.25.101 "docker ps -a --filter 'label=luma.project=<project-name>'"

# View container logs
ssh luma@157.180.25.101 "docker logs --tail 50 <project-name>-web-<release_id>"

# Check project network
ssh luma@157.180.25.101 "docker network inspect <project-name>-network"

# Test application response
ssh luma@157.180.25.101 "curl -I http://localhost:3000"

# View current container resource usage
ssh luma@157.180.25.101 "docker stats --no-stream --filter 'label=luma.project=<project-name>'"

# Check multi-platform image info
ssh luma@157.180.25.101 "docker image inspect web:<release_id> | grep Architecture"
```

### Database-Specific (Basic Example Only)

```bash
# Check database connectivity
ssh luma@157.180.25.101 "docker exec gmail-db pg_isready -U postgres"

# Check database port binding
ssh luma@157.180.25.101 "netstat -tlnp | grep :5433"

# Connect to database
ssh luma@157.180.25.101 "docker exec -it gmail-db psql -U postgres"
```

## Common Issues & Solutions

### 1. Uncommitted Changes Error

```bash
# Solution: Use --force flag or commit changes
bun src/index.ts deploy --force
```

### 2. SSH Connection Issues

```bash
# Test SSH connection
ssh -o ConnectTimeout=10 luma@157.180.25.101 "echo 'Connection successful'"
```

### 3. Multi-Platform Build Issues

```bash
# Verify Docker buildx is available
docker buildx version

# Check available builders
docker buildx ls

# Create a new builder if needed
docker buildx create --use
```

### 4. Container Issues

```bash
# Check if containers are running for a specific project
ssh luma@157.180.25.101 "docker ps --filter 'label=luma.project=<project-name>' --format 'table {{.Names}}\t{{.Status}}'"

# View recent logs for debugging
ssh luma@157.180.25.101 "docker logs --tail 20 <container-name>"
```

### 5. Network Connectivity

```bash
# Test external connectivity (basic example)
curl -I https://test.eliasson.me

# Test external connectivity (nextjs example)
curl -I https://nextjs.example.myluma.cloud

# Test internal connectivity (from server)
ssh luma@157.180.25.101 "curl -I http://localhost:3000"
```

### 6. Proxy Issues

```bash
# Restart proxy if routing is broken
ssh luma@157.180.25.101 "docker restart luma-proxy"

# Check proxy routing configuration
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy list"

# Manually configure proxy routing (if needed)
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy deploy --host example.com --target <project-name>-web:3000 --project myapp --health-path /up"
```

## SSL Certificate Debugging

The Luma proxy uses Let's Encrypt with a pure ACME client implementation for SSL certificate management. Here are essential debugging commands and workflows:

### SSL Certificate Status

```bash
# Check certificate status for all hosts
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy cert-status"

# Check certificate status for specific host
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy cert-status --host your-domain.com"

# List all proxy routes and their health status
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy list"

# Check overall proxy status
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy status"
```

### SSL Certificate Testing

```bash
# Test SSL certificate with verbose output
curl -v https://your-domain.com

# Test SSL certificate validity and chain
curl -I https://your-domain.com

# Check certificate details without making HTTP request
openssl s_client -connect your-domain.com:443 -servername your-domain.com </dev/null 2>/dev/null | openssl x509 -noout -dates -subject
```

### Certificate Provisioning Issues

```bash
# Check proxy logs for SSL/certificate errors
ssh luma@157.180.25.101 "docker logs --tail 50 luma-proxy | grep -i cert"

# Check for Let's Encrypt rate limiting or ACME errors
ssh luma@157.180.25.101 "docker logs --tail 100 luma-proxy | grep -i 'acme\|rate\|limit'"

# Check for certificate acquisition worker logs
ssh luma@157.180.25.101 "docker logs --tail 100 luma-proxy | grep -i 'worker'"

# View real-time logs during certificate requests
ssh luma@157.180.25.101 "docker logs -f luma-proxy" &
curl https://your-new-domain.com  # In another terminal
```

### Health Check Issues

**Common Issue**: Service shows as healthy in `list` but returns 503 errors.

```bash
# Check if containers are running and accessible
ssh luma@157.180.25.101 "docker ps --filter 'label=luma.project=<project-name>'"

# Test internal connectivity from proxy to app
ssh luma@157.180.25.101 "docker exec luma-proxy curl -s -w 'HTTP Status: %{http_code}\n' http://<project-name>-web:3000/"

# Test health endpoint specifically (replace with actual health path)
ssh luma@157.180.25.101 "docker exec luma-proxy curl -s http://<project-name>-web:3000/up"

# Manually update health status if needed
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy updatehealth --host your-domain.com --healthy true"

# Force proxy restart to refresh health checks
ssh luma@157.180.25.101 "docker restart luma-proxy"
```

### Network Connectivity Verification

```bash
# Check proxy network connections
ssh luma@157.180.25.101 "docker inspect luma-proxy --format '{{json .NetworkSettings.Networks}}'"

# Verify proxy can reach project network (using project-specific aliases)
ssh luma@157.180.25.101 "docker exec luma-proxy ping <project-name>-web" # Should resolve via network alias

# Check project network exists and contains containers
ssh luma@157.180.25.101 "docker network inspect <project-name>-network"
```

### End-to-End SSL Deployment Testing

```bash
# Complete deployment and SSL test workflow
cd examples/basic  # or examples/nextjs
bun ../../src/index.ts deploy --force --verbose

# Wait for deployment to complete, then test SSL
sleep 10
curl -v https://test.eliasson.me  # Check for 200 response and valid SSL

# If you get 503 errors, check health status
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy list" | grep test.eliasson.me

# If unhealthy, force update and test again
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy updatehealth --host test.eliasson.me --healthy true"
curl https://test.eliasson.me  # Should now return "Hello World 2"
```

### Certificate Management Commands

```bash
# Force certificate renewal for a specific host
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy cert-renew --host your-domain.com"

# Enable Let's Encrypt staging mode (for testing)
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy set-staging --enabled true"

# Disable staging mode (back to production)
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy set-staging --enabled false"

# Switch traffic for blue-green deployments
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy switch --host your-domain.com --target <project-name>-web-green:3000"
```

### Certificate State Management

```bash
# View the proxy state file (contains all certificate status)
ssh luma@157.180.25.101 "docker exec luma-proxy cat /var/lib/luma-proxy/state.json"

# Check stored certificates on disk
ssh luma@157.180.25.101 "docker exec luma-proxy ls -la /var/lib/luma-proxy/certs/"

# View certificate details from storage
ssh luma@157.180.25.101 "docker exec luma-proxy openssl x509 -in /var/lib/luma-proxy/certs/your-domain.com/cert.pem -noout -dates -subject"

# Backup proxy state (recommended before major changes)
ssh luma@157.180.25.101 "docker cp luma-proxy:/var/lib/luma-proxy/state.json ./proxy-state-backup.json"
```

### Common SSL Issues & Solutions

**1. Certificate Not Provisioning**

- Check DNS points to server IP: `dig your-domain.com`
- Verify ports 80/443 are accessible from internet
- Check Let's Encrypt rate limits in logs: `docker logs luma-proxy | grep -i "rate\|limit"`
- Check certificate status: `docker exec luma-proxy /app/luma-proxy cert-status --host your-domain.com`

**2. 503 Service Unavailable with Valid SSL**

- Health check issue - manually update: `docker exec luma-proxy /app/luma-proxy updatehealth --host your-domain.com --healthy true`
- Container networking issue - verify proxy can reach container: `docker exec luma-proxy ping <project-name>-web`
- App not responding - check container logs: `docker logs <project-name>-web`

**3. Certificate Acquisition Stuck in "acquiring" Status**

- Check certificate attempts: `docker exec luma-proxy /app/luma-proxy cert-status --host your-domain.com`
- View acquisition logs: `docker logs luma-proxy | grep -i cert`
- If max attempts reached, remove and re-deploy the route

**4. Let's Encrypt Rate Limit Hit**

- Enable staging mode for testing: `docker exec luma-proxy /app/luma-proxy set-staging --enabled true`
- Check rate limit errors in logs: `docker logs luma-proxy | grep -i "rate limit"`
- Wait for rate limit to reset (typically 1 hour for failed validations)

**5. Certificate Renewal Issues**

- Force manual renewal: `docker exec luma-proxy /app/luma-proxy cert-renew --host your-domain.com`
- Check renewal worker logs: `docker logs luma-proxy | grep -i "renewal\|worker"`
- Verify certificate expiry: `docker exec luma-proxy /app/luma-proxy cert-status --host your-domain.com`

## Cleanup Commands

### Per Project

```bash
# Remove all containers for a specific project
ssh luma@157.180.25.101 "docker ps -a --filter 'label=luma.project=<project-name>' --format '{{.Names}}' | xargs docker rm -f"

# Remove project network
ssh luma@157.180.25.101 "docker network rm <project-name>-network"
```

### Full Cleanup

```bash
# Remove all Luma-managed containers
ssh luma@157.180.25.101 "docker ps -a --filter 'label=luma.project' --format '{{.Names}}' | xargs docker rm -f"

# Remove all Luma networks
ssh luma@157.180.25.101 "docker network ls --filter 'label=luma.project' --format '{{.Name}}' | xargs docker network rm"
```

## Development Workflow

1. **Choose an example** (`basic` or `nextjs`)
2. **Make changes** to the application code
3. **Deploy** with `bun ../../src/index.ts deploy --force`
4. **Test** the deployment at the configured domain
5. **Debug** using the SSH commands above if issues occur

### Testing Both Examples

```bash
# Deploy basic example
cd examples/basic
bun ../../src/index.ts deploy --force

# Test basic example
curl -I https://test.eliasson.me

# Deploy nextjs example
cd ../nextjs
bun ../../src/index.ts deploy --force

# Test nextjs example
curl -I https://nextjs.example.myluma.cloud
```

## Proxy Development & Testing Workflow

When developing and testing changes to the Luma proxy, follow this complete workflow to ensure proper testing in a clean environment.

### Complete Proxy Testing Cycle

This is the **rock-solid** testing workflow for proxy changes:

```bash
# 1. COMPLETE SERVER CLEANUP (start fresh every time)
ssh luma@157.180.25.101 "docker stop \$(docker ps -aq) 2>/dev/null || true && docker rm \$(docker ps -aq) 2>/dev/null || true && docker rmi \$(docker images -aq) 2>/dev/null || true && docker network prune -f && docker system prune -af --volumes"

# 2. REMOVE .LUMA DIRECTORY (clear all proxy state)
ssh luma@157.180.25.101 "rm -rf ./.luma"

# 3. PUBLISH UPDATED PROXY (after making changes)
cd proxy
./publish.sh
cd ../examples/basic  # or whichever example you're testing

# 4. SETUP INFRASTRUCTURE (pulls latest proxy)
bun ../../src/index.ts setup --verbose

# 5. DEPLOY AND TEST
bun ../../src/index.ts deploy --force --verbose

# 6. VERIFY SSL WORKS IMMEDIATELY
curl -I https://test.eliasson.me
```

### Why Each Step is Critical

1. **Complete Server Cleanup**: Ensures no leftover state from previous tests
2. **Remove .luma Directory**: Clears certificate cache, config files, and proxy state
3. **Publish Updated Proxy**: Makes your changes available for download
4. **Setup Infrastructure**: Pulls the latest proxy image with your changes
5. **Deploy and Test**: Tests the complete flow with your changes
6. **Verify SSL**: Confirms SSL certificates work immediately (no race conditions)

### Proxy Development Workflow

When making changes to the proxy code:

```bash
# 1. Make your changes to proxy source code
cd proxy
# Edit files in internal/, cmd/, etc.

# 2. Test locally (optional - if you have local setup)
go build -o luma-proxy ./cmd/luma-proxy
./luma-proxy run --cert-email test@example.com

# 3. Publish to Docker Hub
./publish.sh

# 4. Test on server with complete cleanup
cd ../examples/basic
# Follow the "Complete Proxy Testing Cycle" above
```

### SSL Certificate Testing Specific

For testing SSL certificate changes specifically:

```bash
# Complete cleanup and setup (as above)
# Then deploy and immediately test SSL multiple times

# Test 1: Immediate SSL after deployment
bun ../../src/index.ts deploy --force
curl -I https://test.eliasson.me  # Should work immediately

# Test 2: Check certificate status
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy status"
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy list"

# Test 3: Verify certificate details
openssl s_client -connect test.eliasson.me:443 -servername test.eliasson.me < /dev/null 2>/dev/null | openssl x509 -noout -dates -subject

# Test 4: Check proxy logs for any issues
ssh luma@157.180.25.101 "docker logs --tail 30 luma-proxy"
```

### Testing Different Scenarios

#### Rate Limiting Scenario

```bash
# Deploy multiple domains quickly to trigger rate limiting
# Modify luma.yml to include multiple hosts, then deploy
bun ../../src/index.ts deploy --force

# Check which succeeded and which are queued
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy status"
```

#### Certificate Renewal Testing

```bash
# Check certificate expiration monitoring
ssh luma@157.180.25.101 "docker exec luma-proxy ls -la /var/lib/luma-proxy/certs/"

# Force certificate renewal (when available)
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy renew --host test.eliasson.me"
```

### Common Testing Pitfalls

❌ **Don't do this:**

- Skip the complete cleanup step
- Test without republishing the proxy first
- Assume SSL works without testing immediately after deployment
- Mix testing between different examples without cleanup

✅ **Always do this:**

- Complete server cleanup before each test cycle
- Publish proxy changes before testing
- Test SSL immediately after deployment
- Check proxy logs for any errors or warnings

### Quick Test Commands

After following the complete cycle above, use these for quick verification:

```bash
# Quick SSL verification
curl -s -o /dev/null -w "%{http_code}" https://test.eliasson.me  # Should return 200

# Quick proxy status
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy list"

# Quick health check
curl -s https://test.eliasson.me/api/health  # Should return "OK"

# Quick container check
ssh luma@157.180.25.101 "docker ps --filter 'label=luma.project=gmail'"
```

### Debugging Proxy Issues

If something goes wrong during testing:

```bash
# 1. Check proxy container status
ssh luma@157.180.25.101 "docker ps --filter 'name=luma-proxy'"

# 2. View recent proxy logs
ssh luma@157.180.25.101 "docker logs --tail 50 luma-proxy"

# 3. Check proxy configuration and routes
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy list"

# 4. Check certificate status
ssh luma@157.180.25.101 "docker exec luma-proxy /app/luma-proxy cert-status"

# 5. Verify network connectivity using project-specific aliases
ssh luma@157.180.25.101 "docker exec luma-proxy ping <project-name>-web"

# 6. Check state file for debugging
ssh luma@157.180.25.101 "docker exec luma-proxy cat /var/lib/luma-proxy/state.json"

# 7. Manual proxy restart (if needed)
ssh luma@157.180.25.101 "docker restart luma-proxy"
```

## File Locations

### Local Structure

- **Root Config**: `./luma.yml` (in each example directory)
- **Local Secrets**: `./.luma/secrets` (in each example directory)
- **Proxy Source**: `./proxy/` (in root)
- **Proxy Publish Script**: `./proxy/publish.sh`

### Server Structure

- **Containers**: Prefixed with `<project-name>-`
- **Networks**: Named `<project-name>-network`
- **Proxy Container**: `luma-proxy`

## Publishing and Distribution

The `publish.sh` script in the proxy directory handles:

- Multi-platform Docker builds (`linux/amd64`, `linux/arm64`)
- Publishing to Docker Hub as `elitan/luma-proxy:latest`
- Automatic buildx setup and configuration

Always test proxy changes locally before running `./publish.sh` to avoid breaking production deployments.

# Luma - Debugging Guide

This guide helps you debug and verify that Luma works across different example applications and configurations.

**⚠️ IMPORTANT: All debugging and testing should use Let's Encrypt staging mode to avoid rate limits. Production certificates are only needed for live deployments.**

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

# Deploy with force flag (skips git commit check) - STAGING MODE
bun ../../src/index.ts deploy --force

# Deploy with verbose output - STAGING MODE
bun ../../src/index.ts deploy --force --verbose

# Deploy only services (e.g., database for basic example)
bun ../../src/index.ts deploy --services --force

# Deploy only apps (skip services)
bun ../../src/index.ts deploy --apps --force
```

**📝 Note**: After deployment, enable staging mode immediately:

```bash
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"
```

### Server Information

- **Server IP**: `157.180.25.101`
- **SSH Username**: `luma`

## Proxy Management

Luma includes a proxy server located in the `proxy/` directory that handles routing and SSL certificates.

**Note**: The proxy uses a **pure HTTP API architecture** for all CLI-to-server communication. It implements a Go-based proxy with ACME client for Let's Encrypt integration, JSON state persistence, and background workers for certificate management.

### Proxy Overview

- **Image**: `elitan/luma-proxy`
- **API**: HTTP API on localhost:8080 (internal communication)
- **Features**:
  - HTTP to HTTPS redirection
  - Host-based routing
  - Automatic Let's Encrypt certificates via ACME protocol
  - Multi-project isolation
  - State persistence in JSON format
  - Background certificate acquisition and renewal workers
  - Pure HTTP API for CLI communication (no Unix socket complexity)

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
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy list"

# Check proxy status (alias for list)
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy status"

# Test proxy health (if you have a route configured)
curl -I https://test.eliasson.me
```

### HTTP API Debugging (Internal Communication)

The proxy now uses a pure HTTP API for all CLI communication on localhost:8080:

```bash
# Test HTTP API directly (from inside proxy container)
ssh luma@157.180.25.101 "docker exec luma-proxy curl -s localhost:8080/api/hosts"

# Check HTTP API server status
ssh luma@157.180.25.101 "docker exec luma-proxy curl -s localhost:8080/api/status"

# View HTTP API logs (look for [API] prefix)
ssh luma@157.180.25.101 "docker logs --tail 50 luma-proxy | grep '\[API\]'"

# Deploy via HTTP API directly (for testing)
ssh luma@157.180.25.101 "docker exec luma-proxy curl -X POST localhost:8080/api/deploy -H 'Content-Type: application/json' -d '{\"host\":\"test.example.com\",\"target\":\"app:3000\",\"project\":\"test\",\"ssl\":true}'"
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
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy list"

# Manually configure proxy routing (if needed)
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy deploy --host example.com --target <project-name>-web:3000 --project myapp --health-path /up"
```

## SSL Certificate Debugging

The Luma proxy uses Let's Encrypt with a pure ACME client implementation for SSL certificate management. **For all debugging and testing, use staging mode to avoid rate limits.**

### Enable Staging Mode (Essential for Testing)

```bash
# ALWAYS enable staging mode for debugging/testing
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"

# Verify staging mode is enabled
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy list" | grep -i staging

# Only disable staging mode for production deployments
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled false"
```

### SSL Certificate Status

```bash
# Check certificate status for all hosts
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy cert-status"

# Check certificate status for specific host
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy cert-status --host your-domain.com"

# List all proxy routes and their health status
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy list"

# Check overall proxy status
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy status"
```

### SSL Certificate Testing (Staging Mode)

```bash
# Test SSL certificate with verbose output (staging certs will show warnings)
curl -v https://your-domain.com

# Test SSL certificate validity (ignore staging warnings for testing)
curl -k -I https://your-domain.com

# Check certificate details (will show staging issuer)
openssl s_client -connect your-domain.com:443 -servername your-domain.com </dev/null 2>/dev/null | openssl x509 -noout -dates -subject -issuer
```

**🔍 Staging Mode Behavior**: Staging certificates will show browser warnings and have "Fake LE Intermediate X1" as the issuer. This is expected and normal for testing.

### Clearing Certificate State for Fresh Testing

When testing SSL certificate acquisition, you need to ensure certificates are not already on disk or in the proxy's internal state. This is essential for testing fresh certificate acquisition flows.

```bash
# Clear all existing certificates from disk storage
ssh luma@157.180.25.101 "docker exec luma-proxy rm -rf /var/lib/luma-proxy/certs/*"

# Remove the JSON state file that tracks certificate status
ssh luma@157.180.25.101 "docker exec luma-proxy rm -f /var/lib/luma-proxy/state.json"

# Restart the proxy to reinitialize with clean state
ssh luma@157.180.25.101 "docker restart luma-proxy"

# Verify clean state - should show no certificates
ssh luma@157.180.25.101 "docker exec luma-proxy ls -la /var/lib/luma-proxy/certs/"

# Verify state file is empty or doesn't exist
ssh luma@157.180.25.101 "docker exec luma-proxy cat /var/lib/luma-proxy/state.json 2>/dev/null || echo 'State file does not exist (clean state)'"
```

**⚠️ Important**: After clearing certificate state, make sure to enable staging mode before testing:

```bash
# Always enable staging mode after clearing state
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"

# Then proceed with your deployment to test fresh certificate acquisition
bun ../../src/index.ts deploy --force
```

**🎯 Testing Fresh Certificate Acquisition**: This cleanup ensures that:

- No cached certificates exist on disk
- The proxy's internal state doesn't think certificates are already available
- Certificate acquisition workers will start fresh for all domains
- You can test the complete certificate acquisition flow from scratch

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
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy updatehealth --host your-domain.com --healthy true"

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

### End-to-End SSL Deployment Testing (Staging Mode)

```bash
# Complete deployment and SSL test workflow with staging mode
cd examples/basic  # or examples/nextjs
bun ../../src/index.ts deploy --force --verbose

# IMMEDIATELY enable staging mode after deployment
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"

# Wait for deployment to complete, then test SSL (ignore browser warnings for staging)
sleep 10
curl -k -v https://test.eliasson.me  # -k flag ignores staging cert warnings

# If you get 503 errors, check health status
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy list" | grep test.eliasson.me

# If unhealthy, force update and test again
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy updatehealth --host test.eliasson.me --healthy true"
curl -k https://test.eliasson.me  # Should now return "Hello World 2"
```

### Certificate Management Commands

```bash
# Force certificate renewal for a specific host (in staging mode)
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy cert-renew --host your-domain.com"

# Enable Let's Encrypt staging mode (DEFAULT for testing)
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"

# ⚠️ Only disable staging mode for production deployments
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled false"

# Switch traffic for blue-green deployments
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy switch --host your-domain.com --target <project-name>-web-green:3000"
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

**1. Certificate Not Provisioning (Staging Mode)**

- Check DNS points to server IP: `dig your-domain.com`
- Verify ports 80/443 are accessible from internet
- **Ensure staging mode is enabled**: `docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true`
- Check certificate status: `docker exec luma-proxy /usr/local/bin/luma-proxy cert-status --host your-domain.com`
- Staging mode has much higher rate limits, so provisioning should be faster

**2. 503 Service Unavailable with Valid SSL (Staging)**

- Health check issue - manually update: `docker exec luma-proxy /usr/local/bin/luma-proxy updatehealth --host your-domain.com --healthy true`
- Container networking issue - verify proxy can reach container: `docker exec luma-proxy ping <project-name>-web`
- App not responding - check container logs: `docker logs <project-name>-web`

**3. Certificate Acquisition Stuck in "acquiring" Status (Staging)**

- Check certificate attempts: `docker exec luma-proxy /usr/local/bin/luma-proxy cert-status --host your-domain.com`
- View acquisition logs: `docker logs luma-proxy | grep -i cert`
- **Verify staging mode is enabled**: `docker exec luma-proxy /usr/local/bin/luma-proxy list | grep -i staging`
- If max attempts reached, remove and re-deploy the route

**4. Testing with Production Rate Limits (NOT RECOMMENDED)**

- **NEVER test with production mode** - always use staging: `docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true`
- If you accidentally hit production rate limits, check: `docker logs luma-proxy | grep -i "rate limit"`
- Wait for rate limit to reset (typically 1 hour for failed validations)

**5. Certificate Renewal Issues (Staging)**

- Force manual renewal: `docker exec luma-proxy /usr/local/bin/luma-proxy cert-renew --host your-domain.com`
- Check renewal worker logs: `docker logs luma-proxy | grep -i "renewal\|worker"`
- Verify certificate expiry: `docker exec luma-proxy /usr/local/bin/luma-proxy cert-status --host your-domain.com`
- Staging certificates expire faster but renew more reliably due to higher rate limits

## Proxy Log Analysis

The proxy implementation provides structured logging with specific prefixes for different components. Understanding these log patterns helps with debugging:

### Log Format Examples

**HTTP API Communication Logs:**

```
2024-01-15T10:30:00Z [API] Deploy request for host api.example.com with SSL=true
2024-01-15T10:30:01Z [API] SSL enabled - starting immediate certificate acquisition for api.example.com
2024-01-15T10:30:02Z [API] Certificate acquisition completed successfully for api.example.com
2024-01-15T10:30:03Z [API] UpdateHealth request for host api.example.com, healthy=true
2024-01-15T10:30:04Z [API] SetStaging request, enabled=true
```

**Certificate Acquisition Process:**

```
2024-01-15T10:30:00Z [CERT] [api.example.com] Starting certificate acquisition
2024-01-15T10:30:01Z [CERT] [api.example.com] ACME challenge created: http-01
2024-01-15T10:30:01Z [CERT] [api.example.com] Challenge URL: /.well-known/acme-challenge/abc123def456
2024-01-15T10:30:02Z [ACME] [api.example.com] Let's Encrypt validation request: GET /.well-known/acme-challenge/abc123def456
2024-01-15T10:30:02Z [ACME] [api.example.com] Challenge response served: 200 OK
2024-01-15T10:30:03Z [CERT] [api.example.com] ACME challenge validation successful
2024-01-15T10:30:04Z [CERT] [api.example.com] Certificate issued successfully
```

**Certificate Acquisition Failures:**

```
2024-01-15T10:30:00Z [CERT] [api.example.com] Starting certificate acquisition
2024-01-15T10:30:01Z [CERT] [api.example.com] ACME challenge created: http-01
2024-01-15T10:30:01Z [CERT] [api.example.com] Challenge URL: /.well-known/acme-challenge/xyz789abc123
2024-01-15T10:30:05Z [CERT] [api.example.com] Challenge validation failed: context deadline exceeded
2024-01-15T10:30:05Z [CERT] [api.example.com] DNS validation failed: NXDOMAIN
2024-01-15T10:30:05Z [CERT] [api.example.com] Acquisition failed, scheduling retry in 10 minutes
2024-01-15T10:30:05Z [CERT] [api.example.com] Attempt 1/144, next attempt: 2024-01-15T10:40:00Z
```

**Health Check Logs:**

```
2024-01-15T10:30:00Z [HEALTH] [api.example.com] Check passed: 200 OK (15ms)
2024-01-15T10:30:30Z [HEALTH] [api.example.com] Check failed: connection refused
2024-01-15T10:31:00Z [HEALTH] [api.example.com] Check passed: 200 OK (12ms)
```

**Request Proxying Logs:**

```
2024-01-15T10:30:00Z [PROXY] api.example.com GET /api/users -> my-project-web:3000 200 (45ms)
2024-01-15T10:30:01Z [PROXY] api.example.com POST /api/auth -> my-project-web:3000 401 (12ms)
2024-01-15T10:30:02Z [PROXY] api.example.com GET / -> 301 (HTTPS redirect)
2024-01-15T10:30:03Z [PROXY] unknown.example.com GET / -> 404 (host not found)
2024-01-15T10:30:04Z [PROXY] api.example.com GET /api/health -> 503 (unhealthy)
```

**CLI Command Logs:**

```
2024-01-15T10:30:00Z [CLI] Deployed host api.example.com -> my-project-web:3000
2024-01-15T10:30:01Z [CLI] Updated health status for api.example.com to true
2024-01-15T10:30:02Z [CLI] Certificate renewal initiated for api.example.com
2024-01-15T10:30:03Z [CLI] Set Let's Encrypt mode to staging
2024-01-15T10:30:04Z [CLI] Switched api.example.com to target my-project-web-green:3000
```

### Log Analysis Commands

```bash
# View HTTP API communication logs
ssh luma@157.180.25.101 "docker logs --tail 50 luma-proxy | grep '\[API\]'"

# View recent certificate-related logs
ssh luma@157.180.25.101 "docker logs --tail 100 luma-proxy | grep '\[CERT\]'"

# View health check logs for specific host
ssh luma@157.180.25.101 "docker logs --tail 50 luma-proxy | grep '\[HEALTH\].*api.example.com'"

# View proxy request logs
ssh luma@157.180.25.101 "docker logs --tail 100 luma-proxy | grep '\[PROXY\]'"

# View ACME challenge handling
ssh luma@157.180.25.101 "docker logs --tail 100 luma-proxy | grep '\[ACME\]'"

# View CLI command history
ssh luma@157.180.25.101 "docker logs --tail 50 luma-proxy | grep '\[CLI\]'"

# Filter logs by specific hostname
ssh luma@157.180.25.101 "docker logs --tail 100 luma-proxy | grep 'api.example.com'"

# Real-time log monitoring during certificate acquisition
ssh luma@157.180.25.101 "docker logs -f luma-proxy | grep -E '\[CERT\]|\[ACME\]'"

# Monitor HTTP API activity in real-time
ssh luma@157.180.25.101 "docker logs -f luma-proxy | grep '\[API\]'"
```

## HTTP API Architecture

The Luma proxy uses a **pure HTTP API architecture** for all CLI-to-server communication. This eliminates complexity and provides reliable, debuggable communication.

### Architecture Overview

```
CLI Commands → HTTP API (localhost:8080) → Proxy Server
                                              ↓
                                    Immediate State Updates
                                              ↓
                                    Certificate Acquisition
                                              ↓
                                    HTTP/HTTPS Servers
```

### HTTP API Endpoints

All CLI commands use these HTTP endpoints for communication:

```
POST   /api/deploy              - Deploy host with immediate cert acquisition
DELETE /api/hosts/:host         - Remove host
GET    /api/hosts               - List all hosts
PUT    /api/hosts/:host/health  - Update health status
POST   /api/cert/renew/:host    - Renew certificate
PUT    /api/staging             - Set Let's Encrypt staging mode
GET    /api/status              - Get certificate status (supports ?host=)
PATCH  /api/hosts/:host         - Switch target
```

### Manual HTTP API Testing

You can test the HTTP API directly for debugging:

```bash
# Deploy a host manually
ssh luma@157.180.25.101 "docker exec luma-proxy curl -X POST localhost:8080/api/deploy \
  -H 'Content-Type: application/json' \
  -d '{
    \"host\": \"test.example.com\",
    \"target\": \"app:3000\",
    \"project\": \"test\",
    \"ssl\": true
  }'"

# List all hosts
ssh luma@157.180.25.101 "docker exec luma-proxy curl -s localhost:8080/api/hosts | jq"

# Check certificate status
ssh luma@157.180.25.101 "docker exec luma-proxy curl -s localhost:8080/api/status | jq"

# Enable staging mode
ssh luma@157.180.25.101 "docker exec luma-proxy curl -X PUT localhost:8080/api/staging \
  -H 'Content-Type: application/json' \
  -d '{\"enabled\": true}'"

# Update health status
ssh luma@157.180.25.101 "docker exec luma-proxy curl -X PUT localhost:8080/api/hosts/test.example.com/health \
  -H 'Content-Type: application/json' \
  -d '{\"healthy\": true}'"

# Remove host
ssh luma@157.180.25.101 "docker exec luma-proxy curl -X DELETE localhost:8080/api/hosts/test.example.com"
```

### HTTP API Benefits

- **Direct Communication**: No file-based coordination or Unix socket complexity
- **Immediate Updates**: State changes happen instantly in the proxy process
- **Easy Debugging**: Manual testing with curl for all operations
- **Reliable**: No race conditions or timing issues
- **Standard HTTP**: Uses familiar HTTP methods and JSON payloads

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
# Deploy basic example with staging mode
cd examples/basic
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"
bun ../../src/index.ts deploy --force

# Test basic example (ignore staging warnings)
curl -k -I https://test.eliasson.me

# Deploy nextjs example with staging mode
cd ../nextjs
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"
bun ../../src/index.ts deploy --force

# Test nextjs example (ignore staging warnings)
curl -k -I https://nextjs.example.myluma.cloud
```

**🎯 Production Deployment Note**: Only switch to production mode for final deployments where you need browser-trusted certificates. Always test thoroughly in staging mode first.

## Proxy Development & Testing Workflow

When developing and testing changes to the Luma proxy, follow this complete workflow to ensure proper testing in a clean environment.

### Complete Proxy Testing Cycle (Staging Mode)

This is the **rock-solid** testing workflow for proxy changes with staging mode:

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

# 5. ENABLE STAGING MODE IMMEDIATELY (before any deployments)
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"

# 6. DEPLOY AND TEST
bun ../../src/index.ts deploy --force --verbose

# 7. VERIFY SSL WORKS IMMEDIATELY (ignore staging warnings)
curl -k -I https://test.eliasson.me  # -k ignores staging cert warnings

# 8. VERIFY STAGING MODE IS ACTIVE
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy list" | grep -i staging
```

### Why Each Step is Critical (Updated for Staging)

1. **Complete Server Cleanup**: Ensures no leftover state from previous tests
2. **Remove .luma Directory**: Clears certificate cache, config files, and proxy state
3. **Publish Updated Proxy**: Makes your changes available for download
4. **Setup Infrastructure**: Pulls the latest proxy image with your changes
5. **Enable Staging Mode**: Critical step to avoid production rate limits
6. **Deploy and Test**: Tests the complete flow with your changes in staging mode
7. **Verify SSL**: Confirms SSL certificates work immediately (with staging certificates)
8. **Verify Staging Mode**: Ensures you're actually using staging and not hitting production limits

### SSL Certificate Testing Specific (Staging Mode)

For testing SSL certificate changes specifically:

```bash
# Complete cleanup and setup (as above)
# CRITICAL: Enable staging mode before any certificate operations
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"

# Then deploy and immediately test SSL multiple times

# Test 1: Immediate SSL after deployment (staging certificates)
bun ../../src/index.ts deploy --force
curl -k -I https://test.eliasson.me  # Should work immediately with staging cert

# Test 2: Check certificate status (should show staging)
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy status"
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy list"

# Test 3: Verify certificate details (should show staging issuer)
openssl s_client -connect test.eliasson.me:443 -servername test.eliasson.me < /dev/null 2>/dev/null | openssl x509 -noout -dates -subject -issuer | grep -i fake

# Test 4: Check proxy logs for any issues
ssh luma@157.180.25.101 "docker logs --tail 30 luma-proxy"
```

### Testing Different Scenarios (Staging Mode)

#### Rate Limiting Scenario (Safe with Staging)

```bash
# Deploy multiple domains quickly - safe in staging mode
# Modify luma.yml to include multiple hosts, then deploy
bun ../../src/index.ts deploy --force

# Check which succeeded and which are queued (should all succeed quickly in staging)
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy status"
```

#### Certificate Renewal Testing (Staging)

```bash
# Check certificate expiration monitoring
ssh luma@157.180.25.101 "docker exec luma-proxy ls -la /var/lib/luma-proxy/certs/"

# Force certificate renewal (staging certs expire faster)
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy cert-renew --host test.eliasson.me"
```

### Production vs Staging Mode Guide

#### When to Use Staging Mode (DEFAULT)

- ✅ All development and testing
- ✅ Debugging proxy issues
- ✅ Testing certificate acquisition logic
- ✅ Learning and experimentation
- ✅ CI/CD pipeline testing

#### When to Use Production Mode (RARE)

- ⚠️ Final production deployments only
- ⚠️ When you need browser-trusted certificates
- ⚠️ Never for testing or debugging

#### Switching Between Modes

```bash
# Enable staging mode (for testing)
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"

# Check current mode
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy list" | grep -i staging

# Enable production mode (only for final deployments)
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled false"
```

### Quick Test Commands (Staging Mode)

After following the complete cycle above, use these for quick verification:

```bash
# Quick SSL verification (ignore staging warnings)
curl -k -s -o /dev/null -w "%{http_code}" https://test.eliasson.me  # Should return 200

# Quick proxy status (should show staging mode enabled)
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy list"

# Quick health check
curl -k -s https://test.eliasson.me/api/health  # Should return "OK"

# Quick container check
ssh luma@157.180.25.101 "docker ps --filter 'label=luma.project=gmail'"

# Verify staging mode is active
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy list" | grep -i staging
```

### Testing Both Examples (Staging Mode)

```bash
# Deploy basic example with staging mode
cd examples/basic
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"
bun ../../src/index.ts deploy --force

# Test basic example (ignore staging warnings)
curl -k -I https://test.eliasson.me

# Deploy nextjs example with staging mode
cd ../nextjs
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"
bun ../../src/index.ts deploy --force

# Test nextjs example (ignore staging warnings)
curl -k -I https://nextjs.example.myluma.cloud
```

**🎯 Production Deployment Note**: Only switch to production mode for final deployments where you need browser-trusted certificates. Always test thoroughly in staging mode first.

## File Locations

### Local Structure

- **Root Config**: `./luma.yml` (in each example directory)
- **Local Secrets**: `./.luma/secrets` (in each example directory)
- **Proxy Source**: `./proxy/`

## HTTP-Only Architecture Changes

### Key Improvements

The Luma proxy has been simplified to use a **pure HTTP API architecture**, removing all backward compatibility complexity:

#### ✅ Removed Components

- **Unix socket server** - No longer needed
- **Unix socket client** - Eliminated
- **Fallback logic** - Simplified to HTTP-only
- **File-based coordination** - Replaced with direct HTTP communication
- **Complex state synchronization** - Now atomic via HTTP API

#### ✅ Simplified Architecture

- **Single communication path**: CLI → HTTP API (localhost:8080) → Proxy
- **Immediate state updates**: Changes happen instantly in proxy process
- **No race conditions**: HTTP request/response ensures atomicity
- **Easy debugging**: All operations testable with curl
- **Clean error handling**: HTTP status codes and JSON responses

#### ✅ CLI Changes

All CLI commands now use HTTP API exclusively:

```bash
# All these commands use HTTP API internally
./luma-proxy deploy --host example.com --target app:3000 --project myapp
./luma-proxy list
./luma-proxy cert-status
./luma-proxy set-staging --enabled true
```

#### ✅ Manual Testing

You can now test all proxy operations manually:

```bash
# Direct HTTP API access for debugging
curl localhost:8080/api/hosts
curl -X POST localhost:8080/api/deploy -d '{"host":"test.com","target":"app:3000"}'
```

#### ✅ Benefits Realized

- **Reliability**: No file coordination race conditions
- **Simplicity**: Single communication method
- **Debuggability**: Manual testing with standard HTTP tools
- **Performance**: Immediate certificate acquisition (4-6 seconds)
- **Maintainability**: Cleaner codebase with fewer components

### Migration Notes

If you're updating from a previous version:

1. **No configuration changes needed** - CLI commands work the same
2. **No deployment changes needed** - Same deployment workflow
3. **Enhanced debugging** - New HTTP API testing capabilities
4. **Improved reliability** - Fewer failure modes and race conditions

**The HTTP-only architecture is production-ready and actively deployed.**

## 🔄 **ITERATIVE DEBUGGING METHODOLOGY**

When troubleshooting issues with Luma (especially SSL certificates, proxy behavior, or deployment problems), follow this systematic debugging approach:

### Debugging Feedback Loop

Fix issues by following this iterative feedback loop:

1. **Test deploy** the basic example project
2. **Check the logs** on the server to see what's happening
3. **Understand the problem** from the log output
4. **Update the code** (proxy or CLI) based on findings
5. **Redeploy** the updated code
6. **Start over again** - repeat this feedback loop until working

### Example Debugging Workflow

```bash
# 1. Test deploy - Start with a deployment
cd examples/basic
bun ../../src/index.ts deploy --force --verbose

# 2. Check the logs - Look for errors or unexpected behavior
ssh luma@157.180.25.101 "docker logs --tail 50 luma-proxy"
ssh luma@157.180.25.101 "docker logs --tail 30 gmail-web"

# 3. Understand the problem - Analyze what you see
# - Are there error messages?
# - Is staging mode enabled?
# - Are certificates being acquired?
# - Are containers running?

# 4. Update the code - Make targeted fixes based on findings
# - Edit proxy source code if needed
# - Update CLI logic if needed
# - Modify configuration if needed

# 5. Redeploy - Push your changes
cd proxy && ./publish.sh && cd ../examples/basic  # If proxy changes
bun ../../src/index.ts setup --verbose            # Pull updated proxy
bun ../../src/index.ts deploy --force --verbose   # Deploy again

# 6. Start over - Repeat until working
# Go back to step 2 and check logs again
```

### Debugging Best Practices

- **Always use staging mode** for SSL testing to avoid rate limits
- **Check logs immediately** after each test
- **Make incremental changes** - fix one issue at a time
- **Document what you tried** - helps avoid repeating failed approaches
- **Test end-to-end** after each fix to ensure no regressions

### Common Debugging Patterns

#### SSL Certificate Issues

```bash
# Deploy → Check SSL logs → Fix ACME client → Redeploy → Test SSL
ssh luma@157.180.25.101 "docker logs --tail 100 luma-proxy | grep -E 'CERT|ACME|SSL'"
```

#### Proxy Routing Issues

```bash
# Deploy → Check proxy logs → Fix routing logic → Redeploy → Test endpoints
ssh luma@157.180.25.101 "docker logs --tail 50 luma-proxy | grep -E 'PROXY|API'"
```

#### Container Health Issues

```bash
# Deploy → Check container status → Fix health checks → Redeploy → Test health
ssh luma@157.180.25.101 "docker ps --filter 'label=luma.project=gmail'"
ssh luma@157.180.25.101 "docker logs --tail 30 gmail-web"
```

This iterative approach helps systematically identify and fix issues without getting stuck on assumptions or trying random solutions.

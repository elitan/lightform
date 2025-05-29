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

### Proxy Overview

- **Image**: `elitan/luma-proxy`
- **Features**:
  - HTTP to HTTPS redirection
  - Host-based routing
  - Automatic Let's Encrypt certificates
  - Multi-project isolation

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

# Check proxy configuration
ssh luma@157.180.25.101 "docker exec luma-proxy luma-proxy status"

# Test proxy health
curl -I https://test.eliasson.me/luma-proxy/health
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
ssh luma@157.180.25.101 "docker exec luma-proxy luma-proxy list"

# Manually configure proxy routing (if needed)
ssh luma@157.180.25.101 "docker exec luma-proxy luma-proxy deploy --host example.com --target localhost:3000 --project myapp"
```

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

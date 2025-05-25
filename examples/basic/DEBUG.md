# Luma Basic Example - Debugging Guide

The `examples/basic` is a project we can use to try and verify that Luma works.

## Quick Start

### Deploy Command

```bash
# Deploy with force flag (skips git commit check)
bun ../../src/index.ts deploy --force

# Deploy with verbose output
bun ../../src/index.ts deploy --force --verbose

# Deploy only services (database)
bun ../../src/index.ts deploy --services --force
```

### Server Information

- **Server IP**: `157.180.25.101`
- **SSH Username**: `luma`
- **Project Name**: `gmail` (as defined in `luma.yml`)

## Debugging Commands

### Local Development

```bash
# Check available commands and flags
bun ../../src/index.ts

# Check deployment status
bun ../../src/index.ts status

# Setup server infrastructure
bun ../../src/index.ts setup
```

### Remote Server Inspection

```bash
# Check running project containers
ssh luma@157.180.25.101 "docker ps --filter 'label=luma.project=gmail'"

# Check all project containers (including stopped)
ssh luma@157.180.25.101 "docker ps -a --filter 'label=luma.project=gmail'"

# View container logs
ssh luma@157.180.25.101 "docker logs --tail 50 gmail-web-<release_id>"

# Check project network
ssh luma@157.180.25.101 "docker network inspect gmail-network"

# Test application response
ssh luma@157.180.25.101 "curl -I http://localhost:3000"

# Check database connectivity
ssh luma@157.180.25.101 "docker exec gmail-db pg_isready -U postgres"

# View current container resource usage
ssh luma@157.180.25.101 "docker stats --no-stream --filter 'label=luma.project=gmail'"

# Check port bindings
ssh luma@157.180.25.101 "netstat -tlnp | grep :5433"
```

## Configuration Details

### Current Setup

- **App**: `web` service running on port 3000
- **Database**: PostgreSQL 17 on port 5433 (mapped from container port 5432)
- **Domain**: `test.eliasson.me`
- **Docker Registry**: Uses `elitan` username

### Environment Variables

- **Plain**: `EXAMPLE_VAR=test`
- **Secrets**: `SECRET_VAR`, `SECRET_VAR_B` (stored in `.luma/secrets`)

## Common Issues & Solutions

### 1. Uncommitted Changes Error

```bash
# Solution: Use --force flag or commit changes
bun ../../src/index.ts deploy --force
```

### 2. SSH Connection Issues

```bash
# Test SSH connection
ssh -o ConnectTimeout=10 luma@157.180.25.101 "echo 'Connection successful'"
```

### 3. Container Issues

```bash
# Check if containers are running
ssh luma@157.180.25.101 "docker ps --filter 'label=luma.project=gmail' --format 'table {{.Names}}\t{{.Status}}'"

# View recent logs for debugging
ssh luma@157.180.25.101 "docker logs --tail 20 gmail-web-\$(docker ps --filter 'label=luma.project=gmail' --filter 'label=luma.type=app' --format '{{.Names}}' | head -1 | cut -d'-' -f3-)"
```

### 4. Network Connectivity

```bash
# Test external connectivity
curl -I https://test.eliasson.me

# Test internal connectivity (from server)
ssh luma@157.180.25.101 "curl -I http://localhost:3000"
```

## Cleanup Commands

```bash
# Remove all project containers
ssh luma@157.180.25.101 "docker ps -a --filter 'label=luma.project=gmail' --format '{{.Names}}' | xargs docker rm -f"

# Remove project network
ssh luma@157.180.25.101 "docker network rm gmail-network"
```

## Development Workflow

1. **Make changes** to `main.go` or `Dockerfile`
2. **Deploy** with `bun ../../src/index.ts deploy --force`
3. **Test** the deployment at `https://test.eliasson.me`
4. **Debug** using the SSH commands above if issues occur

## File Locations

- **Local Config**: `./luma.yml`
- **Local Secrets**: `./.luma/secrets`
- **Server Containers**: Prefixed with `gmail-` (project name)
- **Server Network**: `gmail-network`

# Luma CLI - Developer & AI Agent Guide

## Project Overview

Luma is a TypeScript-based CLI tool for deploying containerized applications to remote servers using Docker and SSH. It provides a simple configuration-driven approach to blue-green deployments with health checks, SSL termination, and reverse proxy management.

### Key Technologies

- **Runtime**: Bun (package management, script execution, TypeScript compilation)
- **Language**: TypeScript
- **Infrastructure**: Docker, SSH, Let's Encrypt
- **Proxy**: Custom Go-based luma-proxy container
- **Deployment**: Blue-green with health checks

## Architecture Overview

### Core Components

1. **CLI Commands** (`src/commands/`)

   - `deploy.ts` - Main deployment orchestration
   - `setup.ts` - Infrastructure setup
   - `init.ts` - Project initialization

2. **Configuration** (`src/config/`)

   - `luma.yml` - Main configuration file
   - `.luma/secrets` - Secret values (passwords, tokens)

3. **Docker Integration** (`src/docker/`)

   - Container lifecycle management
   - Image building, tagging, pushing
   - Network management
   - Health checks

4. **SSH Client** (`src/ssh/`)

   - Remote server communication
   - Command execution on target servers

5. **Proxy System** (`src/proxy/` + external Go container)
   - luma-proxy container (elitan/luma-proxy:latest)
   - Automatic SSL with Let's Encrypt
   - Dynamic routing configuration

### Deployment Flow

```
1. Parse configuration (luma.yml + secrets)
2. Validate git status (no uncommitted changes unless --force)
3. Generate release ID (git commit + timestamp)
4. Build/tag Docker images locally
5. Push images to registry
6. For each target server:
   a. SSH connect
   b. Pull image
   c. Create new container with release ID suffix
   d. Perform health checks using luma-proxy
   e. Configure proxy routing
   f. Clean up old containers
7. Prune Docker resources
```

## Configuration Structure

### luma.yml Example

```yaml
name: "project-name"
apps:
  web:
    image: "my-app"
    build:
      context: "."
      dockerfile: "Dockerfile"
    servers: ["production-server"]
    proxy:
      hosts: ["example.com", "www.example.com"] # Note: array format
      app_port: 3000
    health_check:
      start_period: "10s"

services:
  database:
    image: "postgres:15"
    servers: ["production-server"]
    environment:
      plain:
        POSTGRES_DB: "myapp"
      secret:
        - POSTGRES_PASSWORD

docker:
  registry: "registry.example.com"
  username: "deploy-user"

servers:
  production-server:
    host: "1.2.3.4"
    user: "deploy"
    key_path: "~/.ssh/deploy_key"
```

### .luma/secrets

```
POSTGRES_PASSWORD=secret123
DOCKER_REGISTRY_PASSWORD=registry_token
```

## Network Architecture

- **Project Networks**: Each project gets its own Docker network named `{project-name}-network`
- **Container Naming**: Apps use `{app-name}-{release-id}`, services use `{service-name}`
- **Network Aliases**: Containers get network aliases matching their logical names
- **luma-proxy**: Always-running container on all networks for routing and health checks

## Health Check System

### Current Implementation

- Uses existing `luma-proxy` container instead of temporary Alpine containers
- Executes curl commands from within luma-proxy to target containers
- Verifies `/up` endpoint returns HTTP 200
- Supports custom app ports (extracted from proxy configuration)

### Health Check Flow

```
1. Verify container exists and is on correct network
2. Get container IP address on project network
3. Use luma-proxy container to curl http://{container-ip}:{app-port}/up
4. Expect HTTP 200 response
5. If unhealthy, stop and remove new container
```

## Debugging Common Deployment Issues

### Container Network Problems

```bash
# Check container networks
docker inspect {container-name} --format "{{json .NetworkSettings.Networks}}"

# Verify project network exists
docker network ls | grep {project-name}-network

# Check container connectivity
docker exec luma-proxy curl -s http://{container-ip}:{port}/up
```

### DNS/SSL Issues

```bash
# Check domain resolution
dig {domain-name}
nslookup {domain-name}

# Verify luma-proxy logs
docker logs luma-proxy

# Check SSL certificate status
curl -I https://{domain-name}
```

### SSH/Docker Connection Issues

```bash
# Test SSH connection
ssh -i ~/.ssh/key user@server "docker info"

# Check Docker daemon
systemctl status docker

# Verify user permissions
groups $USER | grep docker
```

## Code Patterns & Best Practices

### Error Handling

- Always wrap SSH/Docker operations in try-catch
- Log errors with server hostname prefix: `[hostname] message`
- Gracefully handle missing containers/networks
- Return boolean success indicators from major operations

### Container Management

- Use descriptive container names with release IDs
- Always check if containers exist before operations
- Clean up old containers after successful deployment
- Use `unless-stopped` restart policy for apps

### Network Communication

- Always verify containers are on expected networks
- Use network aliases for service discovery
- Pass project names through all network-related functions
- Extract ports from configuration, don't hardcode

### Security Considerations

- Store sensitive values in `.luma/secrets`, not `luma.yml`
- Use temporary files for Docker registry passwords
- Set restrictive permissions on secret files
- Clean up temporary files after operations

## luma-proxy Container Details

### Purpose

- HTTP/HTTPS reverse proxy
- Automatic SSL certificate management (Let's Encrypt)
- Dynamic routing configuration
- Health check execution platform

### Key Features

- Dual HTTP (80) and HTTPS (443) listeners
- Certificate auto-renewal
- Volume persistence for certs and config
- REST API for configuration updates

### Management Commands

```bash
# Check proxy status
docker exec luma-proxy /luma-proxy status

# Configure new route
docker exec luma-proxy /luma-proxy deploy --host example.com --target web:3000 --ssl

# View current configuration
docker exec luma-proxy cat /tmp/proxy_config.json
```

## File Structure Reference

```
src/
├── index.ts              # CLI entry point
├── types.ts              # Shared type definitions
├── commands/
│   ├── deploy.ts         # Main deployment logic
│   ├── setup.ts          # Infrastructure setup
│   └── init.ts           # Project initialization
├── config/
│   ├── index.ts          # Config loading utilities
│   └── types.ts          # Configuration type definitions
├── docker/
│   └── index.ts          # Docker client wrapper
├── ssh/
│   └── index.ts          # SSH client implementation
├── proxy/
│   └── index.ts          # luma-proxy integration
└── utils/
    └── index.ts          # Utility functions
```

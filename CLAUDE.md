# Lightform Project - AI Developer Guide

Lightform is a zero-downtime Docker deployment tool that lets you deploy any Docker app to your own servers with automatic HTTPS and no configuration complexity.

**🔧 Package Manager**: This project uses `bun` and not `npm` or other package managers.

**🐛 Debugging**: For live debugging and testing workflows, check out [./DEBUG.md](./DEBUG.md) - it contains comprehensive debugging commands, testing workflows, and troubleshooting guides.

## Project Overview

**Core Value Proposition**: Own your infrastructure without the complexity. Deploy Docker apps to your servers with zero configuration.

**Key Features**:
- Zero-downtime blue-green deployments
- Registry-free deployment (build locally, transfer via SSH)
- Automatic fresh server setup with security hardening
- Auto-SSL with Let's Encrypt and instant domains
- Multi-server support with load balancing
- Git-based releases for easy rollbacks

**Philosophy**: No rollback commands needed - just checkout the git commit you want and run `lightform deploy` again.

## Architecture

### Monorepo Structure
```
packages/
├── cli/          # TypeScript CLI (main user interface)
└── proxy/        # Go reverse proxy (deployed to servers)

examples/
├── basic/        # Simple Go app example
└── nextjs/       # Next.js app example

docs/             # Fumadocs documentation site
```

### CLI (TypeScript) - `./packages/cli/`

**Entry Point**: `src/index.ts` - Main CLI router handling command dispatch

**Core Commands** (`src/commands/`):
- **`init.ts`**: Creates `lightform.yml` config and `.lightform/secrets`
- **`setup.ts`**: Bootstraps fresh servers, installs Docker, configures security
- **`deploy.ts`**: Zero-downtime deployment with blue-green strategy
- **`status.ts`**: Comprehensive status reporting across all servers
- **`proxy.ts`**: Proxy management (status, updates)
- **`blue-green.ts`**: Core zero-downtime deployment logic (used by deploy)

**Supporting Modules**:
- **`config/`**: Configuration parsing and validation with Zod schemas
- **`docker/`**: Docker image building, compression, and transfer
- **`ssh/`**: SSH connection management and command execution
- **`utils/`**: Logging, port checking, SSL domain generation, release management
- **`proxy/`**: Proxy status checking and communication
- **`setup-proxy/`**: Proxy installation and configuration

### Proxy (Go) - `./packages/proxy/`

**Entry Point**: `cmd/lightform-proxy/main.go` - Proxy server with CLI capabilities

**Core Packages** (`internal/`):
- **`api/`**: HTTP API server for CLI communication (localhost:8080)
- **`cert/`**: Let's Encrypt certificate management and renewal
- **`proxy/`**: HTTP/HTTPS reverse proxy with TLS termination
- **`router/`**: Request routing and host-based traffic switching
- **`state/`**: Persistent state management for deployments and certificates
- **`health/`**: Container health checking and monitoring
- **`deployment/`**: Blue-green deployment controller
- **`events/`**: Event bus for internal communication

**Key Concepts**:
- **State Persistence**: All proxy state stored in `/var/lib/lightform-proxy/state.json`
- **Dual Mode**: Runs as proxy server OR CLI commands via HTTP API
- **Background Workers**: Certificate acquisition, renewal, state persistence
- **Zero-Downtime**: Network alias switching for seamless traffic routing

## Development Guidelines

### Building and Testing

```bash
# Build everything
bun run build

# Build specific packages
bun run build:cli    # TypeScript CLI
bun run build:proxy # Go proxy binary

# Run CLI in development
cd packages/cli && bun run start

# Run tests
bun run test        # All tests
bun run test:cli    # CLI tests only
```

### Configuration Files

**`lightform.yml`** (Main config):
```yaml
name: my-app
apps:                    # User-facing applications
  web:
    image: my-app/web
    servers: [server.com]
    build: { context: . }
    proxy: { app_port: 3000 }
    environment:
      secret: [DATABASE_URL]

services:               # Infrastructure services (databases, etc.)
  postgres:
    image: postgres:15
    servers: [db.com]
    environment:
      secret: [POSTGRES_PASSWORD]
```

**`.lightform/secrets`** (Environment variables):
```bash
DATABASE_URL=postgres://user:pass@localhost:5432/myapp
POSTGRES_PASSWORD=supersecret
```

### Key Development Patterns

1. **Error Handling**: All CLI commands use consistent error reporting with suggestions
2. **SSH Operations**: All server communication goes through `ssh/` utilities
3. **State Management**: Proxy maintains authoritative state, CLI queries/updates it
4. **Blue-Green**: Apps get blue/green deployment, services get direct replacement
5. **Security First**: Automatic server hardening, fail2ban, SSH security
6. **Multi-Server**: All operations work across multiple servers in parallel

### Testing Strategy

**Local Testing**:
- Use examples in `examples/` directory
- Test server: `157.180.47.213` (see DEBUG.md)
- Always enable staging mode for SSL testing

**Testing Workflow** (see DEBUG.md for full details):
1. Test deploy the basic example
2. Check logs on server
3. Understand the problem
4. Update code
5. Redeploy
6. Repeat until working

### Code Organization Philosophy

**CLI (`packages/cli/`)**:
- Each command is self-contained in `commands/`
- Shared utilities in `utils/` and supporting modules
- Heavy use of TypeScript for type safety
- Zod schemas for configuration validation

**Proxy (`packages/proxy/`)**:
- Clean separation of concerns with `internal/` packages
- Interfaces defined in `core/interfaces.go`
- Comprehensive test coverage in `test/` directory
- HTTP API for CLI communication

## Common Development Tasks

### Adding a New CLI Command

1. Create `packages/cli/src/commands/new-command.ts`
2. Import and add to router in `packages/cli/src/index.ts`
3. Follow existing patterns for SSH operations and error handling
4. Add tests in `packages/cli/tests/`

### Modifying Proxy Behavior

1. Update relevant package in `packages/proxy/internal/`
2. Test locally with examples
3. Publish updated proxy: `cd packages/proxy && ./publish.sh`
4. Update via CLI: `lightform setup --verbose` (auto-pulls latest)

### Adding Configuration Options

1. Update Zod schemas in `packages/cli/src/config/types.ts`
2. Update example configs in `examples/`
3. Handle new options in relevant command files

## Important Files to Understand

**CLI Core Logic**:
- `packages/cli/src/commands/deploy.ts` - Main deployment orchestration
- `packages/cli/src/commands/blue-green.ts` - Zero-downtime deployment logic
- `packages/cli/src/commands/setup.ts` - Server bootstrapping and infrastructure setup
- `packages/cli/src/config/types.ts` - Configuration schemas and validation

**Proxy Core Logic**:
- `packages/proxy/cmd/lightform-proxy/main.go` - Main entry point and workers
- `packages/proxy/internal/deployment/controller.go` - Deployment management
- `packages/proxy/internal/proxy/proxy.go` - HTTP/HTTPS reverse proxy
- `packages/proxy/internal/cert/manager.go` - SSL certificate management

**Examples and Testing**:
- `examples/basic/` - Simple Go app for testing
- `examples/nextjs/` - Next.js app example
- `DEBUG.md` - Comprehensive debugging and testing guide

## Key Concepts for AI Development

1. **Registry-Free Deployment**: Images built locally, compressed, transferred via SSH
2. **Blue-Green Apps vs Direct Services**: Apps get zero-downtime, services get replaced
3. **Proxy as Source of Truth**: All deployment state lives in the proxy's state file
4. **Server Bootstrap**: Fresh servers get automatic Docker install and security hardening
5. **Auto-SSL with Staging**: Always use Let's Encrypt staging for testing to avoid rate limits
6. **Network Aliases**: Zero-downtime achieved by switching Docker network aliases
7. **Multi-Server**: All operations designed to work across multiple servers in parallel

## Debugging and Troubleshooting

**Primary Resource**: See [DEBUG.md](./DEBUG.md) for comprehensive debugging workflows, commands, and troubleshooting patterns.

**Quick Debug Commands**:
```bash
# Check proxy status
ssh lightform@157.180.47.213 "docker logs --tail 50 lightform-proxy"

# Check deployment status
ssh lightform@157.180.47.213 "docker exec lightform-proxy /usr/local/bin/lightform-proxy list"

# Test connectivity
curl -k -I https://test.eliasson.me
```

## V1 Completion Status

The project is feature-complete for V1 with:
- ✅ Zero-downtime deployments
- ✅ Automatic server setup and security
- ✅ Auto-SSL with Let's Encrypt
- ✅ Multi-server support
- ✅ Comprehensive status reporting
- ✅ Registry-free deployment

**Not needed for V1** (intentional design decisions):
- ❌ Rollback commands (use git checkout + redeploy)
- ❌ Built-in monitoring (operators can integrate external tools)
- ❌ Database migrations (application responsibility)

This is a production-ready deployment tool focused on simplicity and reliability over feature bloat.
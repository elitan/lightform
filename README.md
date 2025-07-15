# Lightform

Zero-downtime Docker deployments with automatic HTTPS. Build locally, deploy to your servers.

```bash
npm install -g lightform-cli
lightform init
lightform       # Deploys with automatic setup - that's it!
```

```yaml
# lightform.yml
name: my-app

ssh:
  username: lightform

apps:
  web:
    build:
      context: .
      dockerfile: Dockerfile
    server: your-server.com
    proxy:
      app_port: 3000
      # hosts:
      #   - myapp.com #- optional, auto-generated if not provided
    environment:
      secret:
        - DATABASE_URL
```

```
❯ lightform
[✓] Ensuring infrastructure is ready (1.2s)
[✓] Building Images (1.8s)
[✓] Zero-downtime deployment of web (3.5s)
[✓] Deployment completed successfully in 9.8s

https://a1b2c3d4-web-lightform-192-168-1-100.app.lightform.dev
```

## Why Lightform?

**Own your infrastructure** without the complexity. Deploy any Docker app to your servers with zero configuration.

**vs Kamal**:

- TypeScript/Bun instead of Ruby
- No Docker registry required - build locally, transfer directly
- Automatic fresh server setup and security hardening
- Instant domains with no DNS configuration needed

**vs Vercel/Netlify**:

- Your own servers - full control, no vendor lock-in
- Any Docker app - not limited to specific frameworks
- No cold starts - containers always running
- Cost-effective - pay only for your servers

**vs Docker Compose**:

- Zero-downtime deployments - Compose restarts cause downtime
- Multi-server support - deploy across multiple machines
- Automatic SSL certificates and reverse proxy
- Git-based releases with rollback capabilities

## Features

- **Zero-downtime deployments**: Blue-green deployment with automatic health checks and rollbacks
- **Registry-free**: Build locally, transfer via SSH (no Docker registry setup needed)
- **Auto-SSL**: Let's Encrypt certificates with automatic domain provisioning
- **Server bootstrap**: Fresh Ubuntu/Debian servers configured automatically with security hardening
- **Multi-server**: Deploy across multiple machines with automatic load balancing
- **Git-based releases**: Each deployment tagged with Git SHA for easy rollbacks
- **Secure by default**: Fail2Ban, automatic updates, SSH hardening, dedicated users

## Configuration

```yaml
name: my-app

ssh:
  username: lightform

apps:
  web:
    build:
      context: .
      dockerfile: Dockerfile
    server: your-server.com
    proxy:
      hosts:
        - myapp.com #- optional, auto-generated if not provided
      app_port: 3000
    environment:
      secret:
        - DATABASE_URL

services:
  postgres:
    image: postgres:15
    server: your-server.com
    environment:
      secret:
        - POSTGRES_PASSWORD
    volumes:
      - postgres_data:/var/lib/postgresql/data
```

Secrets in `.lightform/secrets`:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/myapp
POSTGRES_PASSWORD=supersecret
```

## Commands

```bash
lightform init                    # Create lightform.yml and .lightform/secrets
lightform                         # Deploy all apps (auto-setup included)
lightform web                     # Deploy specific app
lightform --services              # Deploy services only
lightform --verbose               # Deploy with detailed output
lightform status                  # Check deployment status
lightform proxy status            # Check proxy status on all servers
lightform proxy update            # Update proxy to latest version
lightform proxy delete-host --host api.example.com  # Remove host from proxy
lightform proxy logs --lines 100  # Show proxy logs (default: 50 lines)
```

**Note**: Infrastructure setup is automatic. Fresh servers are detected and configured automatically during deployment.

## Examples

**Simple app:**

```yaml
name: blog

ssh:
  username: lightform

apps:
  web:
    build:
      context: .
    server: your-server.com
    proxy:
      app_port: 3000
    environment:
      secret:
        - DATABASE_URL
```

**Monorepo with multiple apps:**

```yaml
# Repository structure:
# /
# ├── lightform.yml
# ├── frontend/
# │   └── Dockerfile
# ├── backend/
# │   └── Dockerfile
# └── mobile-api/
#     └── Dockerfile

name: ecommerce

ssh:
  username: lightform

apps:
  frontend:
    build:
      context: ./frontend # Build context: ./frontend directory
      dockerfile: ./frontend/Dockerfile # Dockerfile path from project root
    server: web-server.com
    proxy:
      hosts:
        - shop.com
      app_port: 3000

  backend:
    build:
      context: ./backend # Build context: ./backend directory
      dockerfile: ./backend/Dockerfile # Dockerfile path from project root
    server: api-server.com
    proxy:
      hosts:
        - api.shop.com
      app_port: 8080
    environment:
      secret:
        - DATABASE_URL
        - JWT_SECRET

  mobile-api:
    build:
      context: ./mobile-api # Build context: ./mobile-api directory
      dockerfile: ./mobile-api/Dockerfile # Dockerfile path from project root
    server: api-server.com
    proxy:
      app_port: 5000
    environment:
      secret:
        - DATABASE_URL

services:
  postgres:
    image: postgres:15
    server: db-server.com
    environment:
      secret:
        - POSTGRES_PASSWORD
    volumes:
      - postgres_data:/var/lib/postgresql/data
```

**Multi-environment:**

```bash
lightform deploy -c lightform.staging.yml
lightform deploy -c lightform.production.yml
```

## How it works

- **Registry-free deployment**: Build Docker images locally, transfer via SSH, deploy with zero downtime
- **Smart server setup**: Detects fresh servers and automatically installs Docker, hardens SSH, sets up users
- **Blue-green deployment**: New version deployed alongside current, health checked, then traffic switched atomically
- **Automatic HTTPS**: Provisions SSL certificates and domains automatically (or use your own)
- **Intelligent infrastructure**: Setup happens automatically during deployment - no separate commands needed

## Requirements

- **Local**: Bun or Node.js 18+
- **Servers**: Ubuntu/Debian with SSH access (root for fresh servers)
- **Ports**: 80, 443 open

Fresh servers only need root SSH access - Lightform handles the rest automatically.

## Development

```bash
git clone https://github.com/elitan/lightform
cd lightform && bun install && bun run dev
```

**MIT License** - Made for developers who want simple, reliable deployments on their own infrastructure.

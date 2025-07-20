# iop

Zero-downtime Docker deployments with automatic HTTPS. Build locally, deploy to your servers.

```bash
npm install -g iop
iop init
iop       # Deploys with automatic setup - that's it!
```

```yaml
# iop.yml
name: my-app

ssh:
  username: iop

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

```bash
❯ iop
[✓] Ensuring infrastructure is ready (1.2s)
[✓] Building Images (1.8s)
[✓] Zero-downtime deployment of web (3.5s)
[✓] Deployment completed successfully in 9.8s

https://a1b2c3d4-web-iop-192-168-1-100.app.iop.dev
```

## Features

- **Zero-downtime deployments**: Blue-green deployment strategy with automatic health checks and traffic switching
- **Registry-free**: Build Docker images locally, compress and transfer via SSH (no Docker registry setup needed)
- **Auto-SSL**: Let's Encrypt certificates with automatic renewal and instant domain provisioning
- **Server bootstrap**: Fresh Ubuntu/Debian servers configured automatically with security hardening
- **Multi-server support**: Deploy across multiple machines with automatic load balancing
- **Git-based releases**: Each deployment tagged with Git SHA for easy rollbacks via git checkout + redeploy
- **Secure by default**: Fail2Ban, automatic updates, SSH hardening, dedicated users, firewall configuration
- **Proxy management**: Built-in reverse proxy with HTTP/HTTPS termination and host-based routing
- **Comprehensive status**: Real-time deployment status across all servers and applications
- **Services vs Apps**: Apps get zero-downtime blue-green deployment, services get direct replacement
- **Network aliases**: Seamless traffic switching using Docker network aliases for true zero-downtime

## Why iop?

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

## Configuration

```yaml
name: my-app

ssh:
  username: iop

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

Secrets in `.iop/secrets`:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/myapp
POSTGRES_PASSWORD=supersecret
```

## Commands

```bash
iop init                    # Create iop.yml and .iop/secrets
iop                         # Deploy all apps (auto-setup included)
iop web                     # Deploy specific app
iop --services              # Deploy services only
iop --verbose               # Deploy with detailed output
iop status                  # Check deployment status
iop proxy status            # Check proxy status on all servers
iop proxy update            # Update proxy to latest version
iop proxy delete-host --host api.example.com  # Remove host from proxy
iop proxy logs --lines 100  # Show proxy logs (default: 50 lines)
```

**Note**: Infrastructure setup is automatic. Fresh servers are detected and configured automatically during deployment.

## Examples

**Simple app:**

```yaml
name: blog

ssh:
  username: iop

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
# ├── iop.yml
# ├── frontend/
# │   └── Dockerfile
# ├── backend/
# │   └── Dockerfile
# └── mobile-api/
#     └── Dockerfile

name: ecommerce

ssh:
  username: iop

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

Fresh servers only need root SSH access - iop handles the rest automatically.

## Community

Join our Discord: https://discord.gg/t4KetSPhWu

## Development

```bash
git clone https://github.com/elitan/iop
cd iop && bun install && bun run dev
```

**MIT License** - Made for developers who want simple, reliable deployments on their own infrastructure.

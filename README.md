# Luma

Zero-downtime Docker deployments with automatic HTTPS. Build locally, deploy to your servers.

```bash
bun install -g @elitan/luma
luma init
luma setup    # bootstraps fresh server automatically
luma deploy   # zero-downtime blue-green deployment
```

```yaml
# luma.yml
name: my-app
apps:
  web:
    image: my-app/web
    servers: [your-server.com]
    build:
      context: .
      dockerfile: Dockerfile
    proxy:
      app_port: 3000
      # hosts: [myapp.com] - optional, auto-generated if not provided
```

```
❯ luma deploy
[✓] Building Images (1.8s)
[✓] Zero-downtime deployment of web (3.5s)
[✓] Deployment completed successfully in 9.8s

https://a1b2c3d4-web-luma-192-168-1-100.sslip.io
```

## Why Luma?

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

apps:
  web:
    image: my-app/web
    servers: [server1.com, server2.com]
    build:
      context: .
      dockerfile: Dockerfile
    proxy:
      hosts: [myapp.com]
      app_port: 3000
    environment:
      secret: [DATABASE_URL]

services:
  postgres:
    image: postgres:15
    servers: [db.com]
    environment:
      secret: [POSTGRES_PASSWORD]
    volumes:
      - postgres_data:/var/lib/postgresql/data
```

Secrets in `.luma/secrets`:
```bash
DATABASE_URL=postgres://user:pass@localhost:5432/myapp
POSTGRES_PASSWORD=supersecret
```

## Commands

```bash
luma init                    # Create luma.yml and .luma/secrets
luma setup                   # Bootstrap servers (auto-detects fresh servers)
luma deploy                  # Deploy all apps
luma deploy web              # Deploy specific app
luma deploy --services       # Deploy services only
luma status                  # Check deployment status
```

## Examples

**Simple app:**
```yaml
name: blog
apps:
  web:
    image: my-blog
    servers: [server.com]
    build: { context: . }
    proxy: { app_port: 3000 }
    environment:
      secret: [DATABASE_URL]
```

**Full-stack with database:**
```yaml
name: ecommerce
apps:
  web:
    image: shop/frontend
    servers: [web1.com, web2.com]
    build: { context: ./frontend }
    proxy: 
      hosts: [shop.com]
      app_port: 3000
  
  api:
    image: shop/backend
    servers: [api.com]
    build: { context: ./backend }
    proxy:
      hosts: [api.shop.com]
      app_port: 8080
    environment:
      secret: [DATABASE_URL, JWT_SECRET]

services:
  postgres:
    image: postgres:15
    servers: [db.com]
    environment:
      secret: [POSTGRES_PASSWORD]
    volumes:
      - postgres_data:/var/lib/postgresql/data
```

**Multi-environment:**
```bash
luma deploy -c luma.staging.yml
luma deploy -c luma.production.yml
```

## How it works

- **Registry-free deployment**: Build Docker images locally, transfer via SSH, deploy with zero downtime
- **Smart server setup**: Detects fresh servers and automatically installs Docker, hardens SSH, sets up users
- **Blue-green deployment**: New version deployed alongside current, health checked, then traffic switched atomically
- **Automatic HTTPS**: Provisions SSL certificates and domains automatically (or use your own)

## Requirements

- **Local**: Bun or Node.js 18+
- **Servers**: Ubuntu/Debian with SSH access (root for fresh servers)
- **Ports**: 80, 443 open

Fresh servers only need root SSH access - Luma handles the rest automatically.

## Development

```bash
git clone https://github.com/elitan/luma
cd luma && bun install && bun run dev
```

**MIT License** - Made for developers who want simple, reliable deployments on their own infrastructure.

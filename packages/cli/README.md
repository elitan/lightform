# iop

> **⚠️ Warning**: This project is in rapid development and should not yet be used in production yet.
>
> [Join our Discord server](https://discord.gg/t4KetSPhWu) to keep up to date.

Zero-downtime Docker deployments with automatic HTTPS. Build locally, deploy to your servers.

**Install and configure:**

```bash
npm install -g iop
iop init
```

This creates your `iop.yml` configuration:

```yaml
# iop.yml
name: my-app

ssh:
  username: iop

services:
  web:
    build:
      context: .
    server: 157.180.47.213
    proxy:
      app_port: 3000
    environment:
      secret:
        - DATABASE_URL
```

**Deploy everything:**

```bash
❯ iop
[✓] Loading configuration (6ms)
[✓] Preparing infrastructure (1.1s)
[✓] Building locally
  ├─ [✓] Build web image (1.3s)
  └─ [✓] Package for transfer (2.2s)
[✓] Reconciling state (703ms)
[✓] Deploying services
  └─ web → 157.180.47.213
     ├─ [✓] Transfer image (6.1s)
     ├─ [✓] Zero-downtime deployment (3.0s)
     └─ [✓] Configure proxy (645ms)

Your app is live at:
  └─ web → https://a1b2c3d4-web-iop-157-180-47-213.app.iop.run
```

**That's it!** Fresh servers are automatically set up with Docker, SSL certificates, and security hardening.

## Features

- **Zero-downtime deployments**: Blue-green deployment strategy with automatic health checks and traffic switching
- **Registry-free**: Build Docker images locally, compress and transfer via SSH (no Docker registry setup needed)
- **Auto-SSL**: Let's Encrypt certificates with automatic renewal and instant domain provisioning
- **Server bootstrap**: Fresh Ubuntu/Debian servers configured automatically with security hardening
- **Multi-server support**: Deploy across multiple machines with automatic load balancing
- **Git-based releases**: Each deployment tagged with Git SHA for easy rollbacks via git checkout + redeploy
- **Secure by default**: Fail2Ban, automatic updates, SSH hardening, dedicated users, firewall configuration
- **Proxy management**: Built-in reverse proxy with HTTP/HTTPS termination and host-based routing
- **Comprehensive status**: Real-time deployment status across all servers and services
- **Smart deployments**: Services with `proxy` config get zero-downtime blue-green deployment, others get stop-start
- **Deployment fingerprinting**: Only redeploys when code, config, or dependencies actually change
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

services:
  web:
    build:
      context: .
      dockerfile: Dockerfile
    server: 157.180.47.213
    proxy:
      hosts:
        - myapp.com # optional, auto-generated if not provided
      app_port: 3000
    environment:
      secret:
        - DATABASE_URL

  postgres:
    image: postgres:15
    server: 157.180.47.213
    ports:
      - "5432:5432"
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
iop                         # Deploy all services (auto-setup included)
iop web postgres            # Deploy specific services by name
iop --verbose               # Deploy with detailed output
iop status                  # Check deployment status across all servers
iop status web              # Check specific service status
iop proxy status            # Check proxy status on all servers
iop proxy update            # Update proxy to latest version
```

**Note**: Infrastructure setup is automatic. Fresh servers are detected and configured automatically during deployment - no separate setup command needed.

## Examples

**With custom domain:**

```yaml
name: my-app

ssh:
  username: iop

services:
  web:
    build:
      context: .
    server: 157.180.47.213
    proxy:
      hosts:
        - myapp.com
      app_port: 3000
    environment:
      secret:
        - DATABASE_URL
```

**With database service:**

```yaml
name: my-app

ssh:
  username: iop

services:
  web:
    build:
      context: .
    server: 157.180.47.213
    proxy:
      app_port: 3000
    environment:
      secret:
        - DATABASE_URL

  postgres:
    image: postgres:15
    server: 157.180.47.213
    ports:
      - "5432:5432"
    environment:
      secret:
        - POSTGRES_PASSWORD
    volumes:
      - postgres_data:/var/lib/postgresql/data
```

## How it works

- **Registry-free deployment**: Build Docker images locally, transfer via SSH, deploy with zero downtime
- **Smart server setup**: Detects fresh servers and automatically installs Docker, hardens SSH, sets up users
- **Blue-green deployment**: Services with `proxy` config get zero-downtime deployment, others use stop-start
- **Deployment fingerprinting**: Analyzes code, config, and dependencies to skip unnecessary rebuilds
- **Automatic HTTPS**: Provisions SSL certificates and domains automatically (or use your own)
- **Intelligent infrastructure**: Setup happens automatically during deployment - no separate commands needed

## Requirements

- **Local**: Node.js 18+ (with Docker for building images)
- **Servers**: Ubuntu/Debian with SSH access (root for fresh servers)  
- **Ports**: 80, 443 open for HTTP/HTTPS traffic

Fresh servers only need root SSH access - iop handles Docker installation and security configuration automatically.

## Community

Join our Discord: https://discord.gg/t4KetSPhWu

## Development

```bash
git clone https://github.com/elitan/iop
cd iop
bun install
bun run build

# Link CLI for local development
cd packages/cli && bun link

# Now you can use iop globally
iop --help
```

**MIT License** - Made for developers who want simple, reliable deployments on their own infrastructure.

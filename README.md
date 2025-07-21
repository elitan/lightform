# iop

> **⚠️ Warning**: This project is in rapid development and should not yet be used in production yet.
>
> [Join our Discord server](https://discord.gg/t4KetSPhWu) to keep up to date.

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
      #   - myapp.com # optional, auto-generated if not provided
    environment:
      secret:
        - DATABASE_URL
```

```bash
❯ iop
[✓] Loading configuration (6ms)
[✓] Preparing infrastructure (1.1s)
[✓] Building locally
  ├─ [✓] Build web1 image (1.3s)
  ├─ [✓] Package for transfer (2.2s)
  ├─ [✓] Build web2 image (1.0s)
  └─ [✓] Package for transfer (2.2s)
[✓] Reconciling state (703ms)
[✓] Deploying services (886ms)
[✓] Deploying applications
  ├─ web1 → 157.180.47.213
  │  ├─ [✓] Transfer image (6.1s)
  │  ├─ [✓] Zero-downtime deployment (3.0s)
  │  └─ [✓] Configure proxy (645ms)
  └─ web2 → 157.180.47.213
     ├─ [✓] Transfer image (6.1s)
     ├─ [✓] Zero-downtime deployment (2.8s)
     └─ [✓] Configure proxy (513ms)

Your apps are live at:
  ├─ web1 → https://cce26bae-web1-iop-157-180-47-213.app.iop.run
  └─ web2 → https://76da4d03-web2-iop-157-180-47-213.app.iop.run
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
iop                         # Deploy all apps and services (auto-setup included)
iop web                     # Deploy specific app by name
iop --services              # Deploy services only
iop --verbose               # Deploy with detailed output
iop status                  # Check deployment status across all servers
iop proxy status            # Check proxy status on all servers
iop proxy update            # Update proxy to latest version
iop proxy delete-host --host api.example.com  # Remove host from proxy
iop proxy logs --lines 100  # Show proxy logs (default: 50 lines)
```

**Note**: Infrastructure setup is automatic. Fresh servers are detected and configured automatically during deployment - no separate setup command needed.

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

**Multiple apps with services:**

```yaml
name: my-app

ssh:
  username: iop

apps:
  web1:
    build:
      context: .
      dockerfile: Dockerfile
    server: your-server.com
    proxy:
      app_port: 3000
    environment:
      secret:
        - DATABASE_URL
    health_check:
      path: /health

  web2:
    build:
      context: .
      dockerfile: Dockerfile
    server: your-server.com
    proxy:
      app_port: 3001
    environment:
      secret:
        - DATABASE_URL
    health_check:
      path: /health

services:
  postgres:
    image: postgres:15
    server: your-server.com
    ports:
      - "5433:5432"
    environment:
      secret:
        - POSTGRES_PASSWORD
    volumes:
      - postgres_data:/var/lib/postgresql/data
```

**Next.js with custom domain:**

```yaml
name: my-nextjs-app

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
        - myapp.com
      app_port: 3000
    environment:
      secret:
        - DATABASE_URL
```

## How it works

- **Registry-free deployment**: Build Docker images locally, transfer via SSH, deploy with zero downtime
- **Smart server setup**: Detects fresh servers and automatically installs Docker, hardens SSH, sets up users
- **Blue-green deployment**: New version deployed alongside current, health checked, then traffic switched atomically
- **Automatic HTTPS**: Provisions SSL certificates and domains automatically (or use your own)
- **Intelligent infrastructure**: Setup happens automatically during deployment - no separate commands needed

## Requirements

- **Local**: Node.js 18+ or Bun
- **Servers**: Ubuntu/Debian with SSH access (root for fresh servers)  
- **Ports**: 80, 443 open for HTTP/HTTPS traffic
- **Docker**: Installed locally for building images

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

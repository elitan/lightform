# iop

Zero-downtime Docker deployments with automatic HTTPS. Build locally, deploy to your servers.

```bash
npm install -g iop
iop init
iop         # Deploys with automatic setup - that's it!
```

## Features

- **Zero-downtime deployments**: Blue-green deployment strategy with automatic health checks and traffic switching
- **Registry-free**: Build Docker images locally, compress and transfer via SSH (no Docker registry setup needed)
- **Auto-SSL**: Let's Encrypt certificates with automatic renewal and instant domain provisioning
- **Server bootstrap**: Fresh Ubuntu/Debian servers configured automatically with security hardening
- **Multi-server support**: Deploy across multiple machines with automatic load balancing
- **Git-based releases**: Each deployment tagged with Git SHA for easy rollbacks via git checkout + redeploy

## Quick Start

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

https://a1b2c3d4-web-iop-192-168-1-100.app.iop.run
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
```

## Documentation

For complete documentation, examples, and guides, visit: https://github.com/elitan/iop

**MIT License** - Made for developers who want simple, reliable deployments on their own infrastructure.

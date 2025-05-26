# Luma: Ship Docker Anywhere ⚡

Zero-downtime deployments and automatic HTTPS on your own servers.

```
❯ luma deploy
Using Git SHA for release ID: 9d8209a
Starting deployment with release 9d8209a

[✓] Configuration loaded (0ms)
[✓] Git status verified (3ms)
[✓] Infrastructure ready (1.2s)
[✓] web → elitan/luma-test-web:9d8209a (3.3s)
[✓] Building Images (3.3s)
  └─ 157.180.25.101
     ├─ [✓] Loading image (2.5s)
     ├─ [✓] Zero-downtime deployment (1.4s)
     └─ [✓] Configuring proxy (319ms)
[✓] Deployment completed successfully in 8.8s

Your app is live at:
  └─ https://test.eliasson.me
```

Luma automatically handles:

- ✅ Zero-downtime blue-green deployments
- ✅ Automatic SSL certificates via Let's Encrypt
- ✅ Health checks and automatic rollbacks
- ✅ Docker image building and secure transfer
- ✅ Multi-server deployments

---

## 🚀 Quick Start

### 1. Install Luma

```bash
npm install -g @elitan/luma
```

### 2. Initialize your project

```bash
cd your-project
luma init
```

This creates:

- `luma.yml` - Your deployment configuration
- `.luma/secrets` - Secure credentials (add to `.gitignore`)

### 3. Configure your app

Edit `luma.yml`:

```yaml
name: my-app

apps:
  web:
    image: my-app/web
    servers:
      - your-server.com
    build:
      context: .
      dockerfile: Dockerfile
    proxy:
      hosts:
        - myapp.com
      app_port: 3000
```

### 4. Set up your server

```bash
luma setup
```

Luma will:

- Install Docker if needed
- Set up the reverse proxy
- Start services

### 5. Deploy!

```bash
luma deploy
```

Watch as Luma builds, deploys, and switches traffic with zero downtime:

```
Starting deployment with release a1b2c3d

[✓] Configuration loaded (2.3s)
[✓] Git status verified (1.2s)
[✓] Infrastructure ready (0.8s)

Building Images
  [✓] web → my-app/web:a1b2c3d (2.1s)

Deploying to Servers
  └─ your-server.com
     ├─ [✓] Loading image (1.3s)
     ├─ [✓] Zero-downtime deployment (3.8s)
     └─ [✓] Configuring SSL proxy (0.5s)

[✓] Deployment completed successfully in 7.7s

Your app is live at:
  └─ https://myapp.com
```

---

## 📋 Prerequisites

- **Local machine**: Bun or Node.js 18+
- **Target servers**:
  - Ubuntu/Debian Linux
  - SSH access with sudo privileges
  - Ports 80 and 443 open

---

## 🆚 Why Luma vs Alternatives?

### vs Kamal (37signals)

- **TypeScript/Bun** instead of Ruby
- **Registry-less deployments** - no need for external Docker registries

### vs Vercel/Netlify

- **Your own servers** - full control, no vendor lock-in
- **Any Docker app** - not limited to specific frameworks
- **Cost-effective** - pay only for your servers
- **No cold starts** - your containers are always running

### vs Docker Compose

- **Zero-downtime deployments** - compose restarts cause downtime
- **Multi-server support** - deploy across multiple machines
- **Automatic SSL** and reverse proxy included
- **Git-based releases** and rollback capabilities

---

## 🎯 Core Concepts

### Apps vs Services

**Apps** are your main applications (web servers, APIs) that you build and deploy with zero-downtime:

```yaml
apps:
  web:
    image: my-app/web
    build:
      context: .
      dockerfile: Dockerfile
    proxy:
      hosts:
        - example.com
      app_port: 3000

  api:
    image: my-app/api
    build:
      context: ./api
    proxy:
      hosts:
        - api.example.com
      app_port: 8080
```

**Services** are supporting infrastructure (databases, caches) that use pre-built images:

```yaml
services:
  postgres:
    image: postgres:15
    environment:
      secret: [POSTGRES_PASSWORD]
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7
```

### Zero-Downtime Deployments

Luma automatically uses blue-green deployment for apps:

1. **Build and transfer** your Docker image securely to servers
2. **Deploy new version** alongside the current one
3. **Health check** the new version via `/health` endpoint
4. **Switch traffic** atomically (sub-millisecond)
5. **Clean up** old version

No Docker registry required - images are transferred directly!

### Registry-Free Operation

Built apps are transferred using secure Docker save/load:

- **Build locally** - your Docker images are built on your machine
- **Transfer securely** - images are saved as tar archives and uploaded via SSH
- **Load remotely** - Docker loads the image directly on your servers
- **No registry needed** - eliminates external dependencies and credentials

Services can still use registries for pre-built images like `postgres:15`.

### Automatic SSL

Luma includes a smart reverse proxy that automatically:

- Obtains SSL certificates via Let's Encrypt
- Routes traffic to your apps
- Handles health checks
- Manages zero-downtime deployments with blue-green switching

---

## 📖 Configuration Reference

### Basic Configuration

```yaml
name: my-project # Required: Project name

# Optional: Global settings
ssh:
  username: deploy # SSH user (default: root)
  port: 22 # SSH port

# Optional: Docker registry (only needed for services using private registries)
docker:
  registry: ghcr.io # Docker registry
  username: myuser # Registry username

apps:
  web:
    image: my-app/web # Docker image name
    servers:
      - server1.com
      - server2.com # Target servers

    # Build configuration (apps are built locally and transferred)
    build:
      context: .
      dockerfile: Dockerfile
      platform: linux/amd64

    # Proxy configuration for web apps
    proxy:
      hosts:
        - example.com
        - www.example.com
      app_port: 3000

    # Environment variables
    environment:
      plain:
        - NODE_ENV=production
        - PORT=3000
      secret:
        - DATABASE_URL # From .luma/secrets
        - API_KEY

    # Health check (optional)
    healthcheck:
      path: /health
      interval: 10s
      timeout: 5s
      retries: 3

services:
  database:
    image: postgres:15
    servers:
      - db.example.com
    environment:
      secret:
        - POSTGRES_PASSWORD
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
```

### Secrets Management

Store sensitive values in `.luma/secrets`:

```bash
# .luma/secrets
DATABASE_URL=postgres://user:pass@localhost:5432/myapp
API_KEY=supersecretkey
# Only needed if using private registries for services
DOCKER_REGISTRY_PASSWORD=myregistrypassword
```

**Important**: Add `.luma/secrets` to your `.gitignore`!

---

## 🛠️ Commands

### `luma init`

Initialize a new project with configuration files.

### `luma setup [service...]`

Prepare servers for deployment. Installs Docker, creates networks, sets up the proxy.

```bash
luma setup              # Set up all servers
luma setup web api      # Set up only servers for web and api
```

### `luma deploy [app...]`

Deploy apps or services with zero downtime.

```bash
luma deploy             # Deploy all apps
luma deploy web         # Deploy specific app
luma deploy --services  # Deploy services instead
luma deploy --force     # Skip git status checks
luma deploy --verbose   # Detailed logging
```

### `luma status [app...]`

Check the status of your deployments.

```bash
luma status             # Status of all apps
luma status web         # Status of specific app

# Example output:
📱 App: web
   Status: ✅ RUNNING (green active)
   Replicas: 2/2 running
   Servers: server1.com, server2.com
```

---

## 🏗️ Examples

### Simple Web App

```yaml
name: blog
apps:
  web:
    image: my-blog
    servers:
      - server.com
    build:
      context: .
    proxy:
      hosts:
        - blog.com
      app_port: 3000
    environment:
      secret: [DATABASE_URL]
```

### Full-Stack App with Database

```yaml
name: ecommerce

apps:
  web:
    image: ecommerce/frontend
    servers:
      - web1.com
      - web2.com
    build:
      context: ./frontend
    proxy:
      hosts:
        - shop.com
        - www.shop.com
      app_port: 3000

  api:
    image: ecommerce/backend
    servers:
      - api.com
    build:
      context: ./backend
    proxy:
      hosts:
        - api.shop.com
      app_port: 8080
    environment:
      secret: [DATABASE_URL, JWT_SECRET]

services:
  postgres:
    image: postgres:15
    servers:
      - db.com
    environment:
      secret: [POSTGRES_PASSWORD]
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7
    servers:
      - cache.com
```

### Microservices with Load Balancing

```yaml
name: platform

apps:
  user-service:
    image: platform/users
    replicas: 3
    servers:
      - app1.com
      - app2.com
    build:
      context: ./services/users
    proxy:
      hosts:
        - users.platform.com
      app_port: 8080

  order-service:
    image: platform/orders
    replicas: 2
    servers:
      - app1.com
      - app2.com
    build:
      context: ./services/orders
    proxy:
      hosts:
        - orders.platform.com
      app_port: 8081
```

---

## 🔒 Security Best Practices

### Server Setup

1. **Create a dedicated deployment user**:

   ```bash
   sudo useradd -m -s /bin/bash deploy
   sudo usermod -aG docker,sudo deploy
   ```

2. **Set up SSH keys**:

   ```bash
   ssh-copy-id deploy@your-server.com
   ```

3. **Configure Luma**:
   ```yaml
   ssh:
     username: deploy
   ```

### Network Security

- Use a firewall to restrict access
- Keep your servers updated

### Secrets Management

- Never commit `.luma/secrets` to version control
- Use environment-specific secrets

## 📚 Advanced Usage

### Custom Health Checks

```yaml
apps:
  api:
    healthcheck:
      path: /api/health
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 60s
```

### Multi-Environment Deployments

```yaml
# luma.staging.yml
name: myapp-staging
apps:
  web:
    image: myapp/web
    build:
      context: .
    servers:
      - staging.myapp.com

# luma.production.yml
name: myapp-prod
apps:
  web:
    image: myapp/web
    build:
      context: .
    servers:
      - prod1.myapp.com
      - prod2.myapp.com
```

Deploy with:

```bash
luma deploy -c luma.staging.yml
luma deploy -c luma.production.yml
```

### Using Docker Registries (Optional)

For services that need private registries or when you prefer registry-based workflows:

```yaml
# Global registry configuration
docker:
  registry: my-registry.com
  username: myuser

services:
  private-service:
    image: my-registry.com/private-service:latest
    # Uses global registry config

apps:
  web:
    # Per-app registry override
    registry:
      url: ghcr.io
      username: different-user
      password_secret: GITHUB_TOKEN
    # Still uses build + transfer, registry only for pre-built images
```

---

### Development Setup

```bash
git clone https://github.com/elitan/luma
cd luma
bun install
bun run dev
```

### Running Tests

```bash
bun test
```

---

## 📄 License

MIT License

---

**Made with ❤️ for developers who want simple, reliable deployments on their own infrastructure.**

# Luma: Ship Docker Anywhere ⚡

Zero-downtime deployments and automatic HTTPS on your own servers.

```
❯ luma deploy --force
Using Git SHA for release ID: 80d0f8c
Starting deployment with release 80d0f8c

[✓] Configuration loaded (1ms)
[✓] Git status verified (4ms)
[✓] Infrastructure ready (879ms)
[✓] web → web:80d0f8c (1.8s)
[✓] Building Images (1.8s)
[✓] App State Reconciliation (884ms)
  └─ web → 157.180.25.101
     ├─ [✓] Loading web image (1.7s)
     ├─ [✓] Zero-downtime deployment of web (3.5s)
     └─ [✓] Configuring proxy for web (805ms)
[✓] Deploying Apps (6.2s)
[✓] Deployment completed successfully in 9.8s

Your app is live at:
  └─ https://a1b2c3d4-web-luma-192-168-1-100.sslip.io
```

Luma automatically handles:

- ✅ Zero-downtime blue-green deployments
- ✅ Automatic SSL certificates via Let's Encrypt
- ✅ Instant domains with sslip.io (no DNS setup required)
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

Watch as Luma builds, deploys, and switches traffic with zero downtime.

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
3. **Health check** the new version via configured health endpoint
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

### Instant Domains with sslip.io

When you don't specify custom domains in your `proxy.hosts` configuration, Luma automatically generates working domains using [sslip.io](https://sslip.io):

```yaml
apps:
  web:
    # No hosts specified - Luma generates sslip.io domain automatically
    proxy:
      app_port: 3000
```

After deployment, your app will be available at a URL like:
- `https://a1b2c3d4-web-luma-192-168-1-100.sslip.io`

**Benefits:**
- ✅ **No DNS setup required** - works immediately
- ✅ **Automatic HTTPS** - Let's Encrypt certificates provisioned instantly  
- ✅ **Deterministic URLs** - same project+app+server always generates the same domain
- ✅ **Perfect for testing** - get a working HTTPS domain in seconds

The domain format is: `{hash}-{app}-luma-{server-ip}.sslip.io` where the hash is deterministically generated from your project name, app name, and server IP.

### Health Checks

Luma performs automatic health checks during deployments to ensure zero-downtime deployments. Your application must implement a health check endpoint that returns HTTP 200 when healthy.

The default health check endpoint is `/up` but you can configure it to any path you want.

```yaml
apps:
  api:
    health_check:
      path: /health # Health check endpoint (default: /up)
```

**Health Check Behavior (Automatic):**

- **Method**: HTTP GET request
- **Success criteria**: HTTP 200 response
- **Timeout**: 5 seconds
- **Retries**: 3 attempts
- **Port**: Uses the configured `app_port` (defaults to 80)

The only configurable option is:

- **path**: Health check endpoint path (default: `/up`)

All other health check behavior is handled automatically by Luma to ensure reliable deployments.

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
    health_check:
      path: /health # Health check endpoint (default: /up)

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

### Server Preparation Guide (from root)

Follow these steps to securely prepare your server for Luma deployments. All commands should be run as the `root` user (or with `sudo`).

1. **Create a dedicated user for Luma:**

```bash
sudo adduser luma
# Follow the prompts to set a password (it will be disabled later) and user details.
sudo usermod -aG sudo luma # Add luma to the sudo group
```

2. **Install Docker Engine:**

Luma requires Docker to be installed on your target servers.

```bash
# Update package lists
sudo apt-get update

# Install prerequisites
sudo apt-get install -y ca-certificates curl

# Create keyrings directory
sudo install -m 0755 -d /etc/apt/keyrings

# Add Docker's official GPG key
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add Docker's stable repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Update package lists again
sudo apt-get update

# Install Docker CE with all plugins
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add the luma user to the docker group
sudo usermod -aG docker luma

# Verify installation
sudo docker run hello-world
```

_Note: You might need to log out and log back in as the `luma` user for the group changes to take effect, or use `newgrp docker` in the `luma` user's session._

3. **Set up SSH Key-Based Authentication for `luma`:**

   **Prerequisites:** This step assumes you already have SSH keys generated on your local machine. If you don't have SSH keys yet, generate them first:

```bash
ssh-keygen -t rsa -b 4096 -C "your_email@example.com"
# Follow the prompts. It's recommended to use a passphrase for your key.
```

**Copy your public key to the server:**
Replace `your-server.com` with your server's IP address or hostname.

```bash
ssh-copy-id luma@your-server.com
```

This command will copy your local machine's public SSH key to the `luma` user's `~/.ssh/authorized_keys` file on the server.

4. **Secure SSH Configuration:**

Disable password authentication and make other security improvements to your SSH server. Edit the SSH daemon configuration file (`/etc/ssh/sshd_config`) on the server:

```bash
sudo nano /etc/ssh/sshd_config
```

Make the following changes:

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
ChallengeResponseAuthentication no
UsePAM no # If you are sure you don't need PAM for SSH
```

After saving the changes, restart the SSH service:

```bash
sudo systemctl restart ssh
```

**Important:** Ensure your SSH key authentication is working correctly before disabling password authentication, or you could lock yourself out of the server. Test by logging in from a new terminal window: `ssh luma@your-server.com`.

5. **Install Fail2Ban:**

Fail2Ban helps protect your server from brute-force attacks.

```bash
sudo apt-get update
sudo apt-get install -y fail2ban
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

Fail2Ban works out-of-the-box with default settings for SSH. You can customize its configuration in `/etc/fail2ban/jail.local`.

6. **Configure Luma:**

In your `luma.yml` file, ensure you specify the `luma` user for SSH connections:

```yaml
ssh:
  username: luma
  # port: 22 # If you changed the SSH port
```

After completing these steps, your server will be more secure and ready for Luma deployments.

### Secrets Management

- Never commit `.luma/secrets` to version control
- Use environment-specific secrets

## 📚 Advanced Usage

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

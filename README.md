# Luma CLI

Luma CLI is a tool for managing the deployment of your applications.

## Installation

Ensure you have Bun installed. Then, you can run the CLI directly:

```bash
bun src/index.ts <command>
```

Or, build it and then run the executable (details TBD).

## Commands

### `init`

Initializes a new Luma project. This creates:

- `luma.yml`: The main configuration file for your services.
- `.luma/secrets`: A file to store sensitive information like API keys or passwords. This file should be added to `.gitignore`.

```bash
bun src/index.ts init
```

### `setup`

Prepares your target servers for deployment. For each unique server defined across your services, this command will:

1.  Connect via SSH.
2.  Check if Docker is installed and accessible.
3.  **If Docker is not installed or the SSH user cannot access it:**
    - The command will output instructions for manually bootstrapping the server (e.g., installing Docker, adding the user to the `docker` group).
    - It will then skip further setup for that server.
4.  **If Docker is installed and accessible:**
    - It will attempt to log into the configured Docker registry if credentials (`docker.username` in `luma.yml` and `DOCKER_REGISTRY_PASSWORD` in `.luma/secrets`) are provided.

You can optionally specify service names to set up only the servers associated with those services:

```bash
bun src/index.ts setup
bun src/index.ts setup my-service1 my-service2
```

### `deploy`

Deploys your applications and services to target servers. The deploy command provides a clean, hierarchical output showing the progress of each phase.

**Basic usage:**

```bash
# Deploy all apps
bun src/index.ts deploy

# Deploy specific apps
bun src/index.ts deploy my-webapp my-worker

# Deploy all services
bun src/index.ts deploy --services

# Deploy specific services
bun src/index.ts deploy --services my-database my-cache
```

**Flags:**

- `--force`: Skip Git status checks and deploy even with uncommitted changes
- `--services`: Deploy services instead of apps
- `--verbose`: Show detailed logging for debugging

**Example output:**

```
🚀 Starting deployment with release 5a13fe6

✅ Configuration loaded
✅ Git status verified
✅ Infrastructure ready

📦 Building & Pushing Images
  └─ web → elitan/luma-test-web:5a13fe6 ✅ (2.1s)

🔄 Deploying to Servers
  └─ 157.180.25.101
     ├─ Pulling image ✅ (1.3s)
     ├─ Zero-downtime deployment ✅ (3.8s)
     └─ Configuring proxy ✅ (0.5s)

✅ Deployment completed successfully in 7.7s

🌐 Your app is live at:
  └─ https://test.eliasson.me
```

### Other Commands

- `redeploy`: (To be implemented) Redeploys services, potentially without rebuilding.
- `rollback`: (To be implemented) Rolls back to a previous deployment.

## Configuration

### `luma.yml`

This file defines the services you want to manage.

**Structure:**

```yaml
# Optional: Global SSH settings.
# If not provided, Luma defaults to user 'root' on port 22.
# These can be overridden by your local ~/.ssh/config for specific hosts.
ssh:
  username: your_ssh_user # e.g., deployer
  port: 2222 # e.g., a non-standard SSH port

# Optional: Global Docker registry settings.
# Can be overridden at the service level.
docker:
  registry: my.private-registry.com
  username: my_registry_user # Password for this user should be in .luma/secrets

# Optional: Luma proxy configuration
proxy:
  image: my-registry.com/custom-luma-proxy:latest # Configure a custom proxy image

# Define your primary applications under 'apps'.
# These are typically built by Luma and benefit from zero-downtime deployment.
apps:
  # Example App: A simple web application
  my-webapp:
    # Required: Docker image name.
    # If you are building the image, this is the target image name.
    # If you are using a pre-built image, this is the image to pull.
    image: your_registry.example.com/my-webapp

    # Required: List of servers to deploy this app to (IPs or hostnames).
    # Luma will connect to these servers via SSH.
    servers:
      - 192.168.1.101
      - my-server-2.example.com

    # Optional: App-specific registry override.
    # Uncomment and configure if this app uses a different registry than the default.
    # registry:
    #   username: app_specific_username
    #   password_secret: APP_REGISTRY_PASSWORD_VAR

    # Optional: Configuration for building the Docker image.
    # Required if you are building your own image from a Dockerfile.
    # If omitted, Luma assumes the 'image' already exists in the registry.
    build:
      # Path to the build context (e.g., '.' for monorepo root, 'apps/my-webapp' for a specific app dir).
      context: .
      # Path to the Dockerfile relative to the context.
      dockerfile: Dockerfile
      # Optional: Build arguments passed to docker build --build-arg.
      # args:
      #   - NODE_VERSION=18
      #   - BUILD_ENV=production

    # Optional: Environment variables for the container.
    environment:
      # Values sourced from the secrets file (.luma/secrets).
      # Luma will inject these as environment variables into the container.
      secret:
        - DATABASE_URL
        - API_KEY

      # Values defined directly in this config file.
      plain:
        - PORT=8080
        - NODE_ENV=production

    # Optional: Port mapping from host to container (HOST_PORT:CONTAINER_PORT).
    # Luma will use the host port for health checks if configured.
    ports:
      - "80:8080" # Map host port 80 to container port 8080
      - "443:8443" # Example for HTTPS

    # Optional: Volumes to mount (HOST_PATH:CONTAINER_PATH or named_volume:CONTAINER_PATH).
    volumes:
      - app_data:/var/lib/my-webapp # Example named volume
      - /etc/nginx/conf.d:/etc/nginx/conf.d:ro # Example bind mount (read-only)

    # Optional: Health check configuration.
    # Luma will wait for this endpoint to return a 2xx status code before considering the new container healthy.
    # Primarily used for apps to enable basic zero-downtime updates.
    healthcheck:
      # HTTP path to check (e.g., /healthz, /status).
      path: /healthz
      # Check interval (e.g., 5s, 1m).
      interval: 10s
      # Check timeout (e.g., 3s, 30s).
      timeout: 5s
      # Number of retries before failure.
      retries: 3
      # Initial delay before health checks start (e.g., 30s).
      start_period: 15s

  # Example App: A background worker
  my-worker:
    image: your_registry.example.com/my-worker
    servers:
      - 192.168.1.102
    build:
      context: ./worker
      dockerfile: Dockerfile
    environment:
      secret:
        - QUEUE_CONNECTION_STRING
      plain:
        - WORKER_CONCURRENCY=5
    # Workers might not expose ports or need health checks in the same way as web apps.
    # ports: [] # No exposed ports
    # healthcheck: # No HTTP health check needed
    #   ...

# Define supporting services (like databases, caches) under 'services'.
# Luma manages these with a simpler stop-and-start deployment.
# Note: In Luma, 'services' refers to supporting infrastructure like databases or caches,
# distinct from the 'apps' that Luma builds and deploys with zero-downtime features.
services:
  # Example Service: A database
  my-database:
    # Required: Docker image name (usually from a public registry like Docker Hub).
    image: postgres:14

    # Required: List of servers to deploy this service to.
    # Often deployed to a dedicated database server.
    servers:
      - 192.168.1.201

    # Optional: Service-specific registry (e.g., if using a private Postgres image).
    # registry:
    #   ...

    # Optional: Environment variables (e.g., for database initialization).
    environment:
      secret:
        - POSTGRES_PASSWORD
        - POSTGRES_USER
        - POSTGRES_DB
      # plain:
      #   - PGDATA=/var/lib/postgresql/data

    # Optional: Port mapping (often internal or to a specific host interface for security).
    ports:
      - "127.0.0.1:5432:5432" # Bind to localhost for internal access only

    # Optional: Volumes for persistent data. Crucial for databases!
    volumes:
      - postgres_data:/var/lib/postgresql/data # Example named volume

    # Health check can be defined but is NOT used for zero-downtime switching on services in MVP.
    # healthcheck:
    #   ...

  # Example Service: A cache
  my-cache:
    image: redis:7
    servers:
      - 192.168.1.202
    # No build needed for standard Redis image
    # No registry override needed for Docker Hub
    environment:
      secret:
        - REDIS_PASSWORD
    ports:
      - "6379:6379" # Default Redis port
    volumes:
      - redis_data:/data # Volume for persistence (optional for cache)
    # No health check needed for zero-downtime in MVP
    # healthcheck:
    #   ...
```

### `.luma/secrets`

This file is for storing sensitive data that should not be committed to your repository (ensure `.luma/` or `.luma/secrets` is in your `.gitignore`). It's a simple key-value store.

**Format:**
Each line should be `KEY=VALUE`. Lines starting with `#` are comments and are ignored.

```
# .luma/secrets example
DEFAULT_SSH_KEY_PATH=~/.ssh/id_rsa_luma_project
# DEFAULT_SSH_PASSWORD=your_ssh_password_if_not_using_keys
DOCKER_REGISTRY_PASSWORD=your_docker_registry_password

# Service-specific secrets
DATABASE_URL_SECRET=postgres://user:pass@host:port/dbname
API_KEY_SECRET=supersecretapikey
AMQP_CONNECTION_STRING_SECRET=amqp://guest:guest@localhost:5672/
```

## SSH Connection Handling

Luma connects to your servers via SSH. Here's how connection parameters (user, port, identity file, etc.) are determined, in order of precedence:

1.  **`~/.ssh/config`**: Your local SSH client configuration file. If you have entries for specific hosts (e.g., using `Host`, `HostName`, `User`, `Port`, `IdentityFile`), these will take the highest precedence. This is the recommended way to manage complex or per-host SSH settings.
2.  **`luma.yml` (`ssh:` section)**: You can specify a global `username` and `port` in the `ssh:` section of your `luma.yml`. These will be used if no specific configuration is found in `~/.ssh/config` for a host.
3.  **Defaults**: If neither `~/.ssh/config` nor `luma.yml` provide specific settings, Luma defaults to:
    - User: `root`
    - Port: `22`

**SSH Key Management:**

- Luma will attempt to use your SSH agent if available.
- You can specify a default SSH private key path in `.luma/secrets` using `DEFAULT_SSH_KEY_PATH`.
- For host-specific keys, configure them in `~/.ssh/config` using the `IdentityFile` directive.
- Password-based authentication can be used if `DEFAULT_SSH_PASSWORD` is set in secrets and no key-based methods succeed (though key-based authentication is strongly recommended).

**Server Prerequisites for `setup` command:**

- The target server must be accessible via SSH using the determined credentials.
- **Docker must be installed on the server.**
- The SSH user must have permission to manage Docker containers. This usually means:
  - The user is part of the `docker` group (e.g., `sudo usermod -aG docker your_ssh_user`). You'll need to log out and back in for group changes to take effect on the server.
  - Or, the user has passwordless `sudo` privileges to run Docker commands (less common for direct Docker management).
- If these conditions are not met, the `setup` command will provide manual instructions to prepare the server.

## Security Recommendations

### Avoiding Root for SSH

For security reasons, Luma CLI will warn you if you're using the `root` user for SSH connections. Using a non-root user with limited permissions is a security best practice. Here's how to set up a dedicated user for Luma deployments:

1. SSH into your server as root (last time!):

   ```bash
   ssh root@your-server.example.com
   ```

2. Create a new user with sudo privileges (example uses 'luma' as username):

   ```bash
   useradd -m -s /bin/bash luma
   passwd luma  # Set a strong password
   usermod -aG sudo luma
   ```

3. Set up SSH for the new user:

   ```bash
   mkdir -p /home/luma/.ssh
   cp ~/.ssh/authorized_keys /home/luma/.ssh/  # Copy your existing authorized keys
   chown -R luma:luma /home/luma/.ssh
   chmod 700 /home/luma/.ssh
   chmod 600 /home/luma/.ssh/authorized_keys
   ```

4. Test the new user login from your local machine:

   ```bash
   ssh luma@your-server.example.com
   ```

5. Update your `luma.yml` to use this user instead of root:

   ```yaml
   ssh:
     username: luma
   ```

6. (Optional but recommended) Disable root SSH login for improved security:
   ```bash
   sudo nano /etc/ssh/sshd_config
   # Find "PermitRootLogin" and change to "PermitRootLogin no"
   sudo systemctl restart sshd
   ```

### Installing Docker on Your Server

If Luma detects that Docker is not installed on your server, it will exit early with a warning. Here's how to install Docker on common Linux distributions:

#### Ubuntu/Debian:

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y docker.io curl git
sudo usermod -a -G docker luma
```

Once Docker is successfully installed, you can run `luma setup` again to continue with the deployment setup.

## Contributing

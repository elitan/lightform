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

### Other Commands

- `deploy`: (To be implemented) Deploys your services.
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

services:
  my-web-app:
    image: nginx:latest # Docker image to use (e.g., from Docker Hub or your private registry)
    servers:
      - 192.168.1.100 # IP address or hostname of the server
      - server2.example.com
    # Optional: Build settings if Luma should build the image
    build:
      context: ./my-web-app-src # Path to the build context
      dockerfile: Dockerfile # Path to the Dockerfile within the context
    # Optional: Port mappings (host:container)
    ports:
      - "80:80"
      - "443:443"
    # Optional: Environment variables
    environment:
      plain: # Plain text variables
        - NODE_ENV=production
        - API_URL=https://api.example.com
      secret: # Names of secrets to source from .luma/secrets
        - DATABASE_URL_SECRET # Will look for DATABASE_URL_SECRET in .luma/secrets
        - API_KEY_SECRET
    # Optional: Override global Docker registry for this service
    registry: another.registry.com

  my-worker:
    image: my-custom-worker
    servers:
      - 192.168.1.101
    build:
      context: ./my-worker-src
      dockerfile: Dockerfile.worker
    environment:
      plain:
        - QUEUE_NAME=important_jobs
      secret:
        - AMQP_CONNECTION_STRING_SECRET
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
# Update package index
sudo apt update

# Install dependencies
sudo apt install -y apt-transport-https ca-certificates curl software-properties-common

# Add Docker's official GPG key
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

# Add the Docker repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io

# Add your user to the docker group (replace 'luma' with your username)
sudo usermod -aG docker luma

# Apply group changes (or log out and back in)
newgrp docker
```

#### CentOS/RHEL:

```bash
# Install required packages
sudo yum install -y yum-utils

# Add Docker repository
sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo

# Install Docker
sudo yum install -y docker-ce docker-ce-cli containerd.io

# Start and enable Docker
sudo systemctl start docker
sudo systemctl enable docker

# Add your user to the docker group
sudo usermod -aG docker your-username

# Apply group changes (or log out and back in)
newgrp docker
```

After installation, verify Docker is working:

```bash
docker --version
docker info
```

Once Docker is successfully installed, you can run `luma setup` again to continue with the deployment setup.

## Contributing

(Details TBD)

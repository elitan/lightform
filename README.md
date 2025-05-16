# Luma - Open Source Cloud Run Alternative

Luma is a lightweight, open-source alternative to [Google Cloud Run](https://cloud.google.com/run), designed to demonstrate core "scale-to-zero" functionality. It automatically starts and stops Docker containers based on incoming HTTP requests, providing an efficient way to run your applications.

## Features

- **On-Demand Container Scaling**: Starts containers when traffic arrives and automatically stops them after a period of inactivity
- **Hostname-Based Routing**: Routes requests to the appropriate container based on the hostname
- **Docker Integration**: Seamlessly manages container lifecycle using the Docker SDK
- **Simple API**: Register projects with a straightforward API endpoint
- **Zero Configuration**: Minimal setup required to get started

## How Luma Works

Luma operates with two main server components:

- **Proxy Server (Port 8080):** Handles incoming HTTP requests for your services, routing them based on hostname.
- **API Server (Port 8081):** Manages project registrations. Project configurations are stored in memory.

### On-Demand Container Management & Request Flow

1.  When a request for a service (e.g., `myapp.localhost`) reaches the Proxy Server, the `Reverse Proxy` component identifies the target project.
2.  The `State Manager` checks the project's container status. Common states include: `idle`, `starting`, `running`, `stopping`, `stopped`.
3.  If the container is `idle`, the `State Manager` directs the `Container Manager` to start it. The `Container Manager` uses the Docker Engine to launch the container, which is assigned a dynamic host port. Luma is designed to gracefully handle concurrent requests to start the same container.
4.  Once the container is `running`, the request is proxied to it.
5.  Responses are routed back to the user via the Proxy Server.

### Scale-to-Zero & Resource Management

- A background process within the `State Manager` monitors container activity.
- After a configurable period of inactivity (default: 20 seconds), the `State Manager` instructs the `Container Manager` to stop inactive containers, thereby conserving resources.
- Containers are also safely stopped when Luma itself shuts down.
- Synchronization for state changes and container operations is handled with appropriate mutex locking to ensure data consistency.

## Project Structure

- `main.go` - Application entry point, initializes components and servers
- `api/` - API handlers for project registration
- `manager/` - Core business logic:
  - `container_manager.go` - Manages Docker container lifecycle
  - `state_manager.go` - Tracks project configurations and container states
- `proxy/` - HTTP reverse proxy that routes requests to containers
- `types/` - Core data models and interfaces

## Prerequisites

- Go (version 1.21 or higher recommended)
- Docker installed and running

## Getting Started

1. **Clone the repository:**

   ```bash
   git clone <repository-url>
   cd luma
   ```

2. **Ensure dependencies are downloaded:**

   ```bash
   go mod tidy
   ```

3. **Run for local development:**

   ```bash
   go run main.go
   ```

   The service will start:

   - Proxy server on port `:8080`
   - API server on port `:8081`

## Usage

### Registering a Project

To register a project, send a `POST` request to the `/projects` endpoint on the API server (port 8081):

```bash
curl -X POST http://localhost:8081/projects -H "Content-Type: application/json" -d '{
  "name": "my-nginx-app",
  "docker_image": "nginxdemos/hello",
  "env_vars": {
    "APP_ENV": "development"
  },
  "container_port": 80,
  "hostname": "myapp.localhost"
}'
```

**Parameters:**

- `name`: A unique name for your project
- `docker_image`: The Docker image to run
- `env_vars`: Environment variables to set in the container
- `container_port`: The port your application listens on inside the container
- `hostname`: The hostname that Luma will use to route requests to this project

### Accessing Your Service

Once registered, the proxy server will route requests to your container based on the hostname:

```bash
curl -H "Host: myapp.localhost" http://localhost:8080
```

Or if you've configured your hosts file:

```bash
curl http://myapp.localhost:8080
```

How the host file would have to be configured:

```bash
127.0.0.1 myapp.localhost
```

## Project Structure

- `main.go` - Application entry point, initializes components and servers
- `api/` - API handlers for project registration
- `manager/` - Core business logic:
  - `container_manager.go` - Manages Docker container lifecycle
  - `state_manager.go` - Tracks project configurations and container states
- `proxy/` - HTTP reverse proxy that routes requests to containers
- `types/` - Core data models and interfaces

## System Architecture

1. User Request (HTTP to :8080 for a service like myapp.localhost):

   - Hits `Proxy Server`.
   - `Reverse Proxy` identifies the project by hostname.
   - `Reverse Proxy` checks with `State Manager`:
     - `State Manager` reads `Project Configurations` (in-memory).
     - If container is NOT running:
       - `State Manager` tells `Container Manager`.
       - `Container Manager` interacts with `Docker Engine` to start the container.
       - `State Manager` updates container status.
   - `Reverse Proxy` forwards request to the now `Running Container`.
   - `Running Container` sends response back through `Reverse Proxy` -> `Proxy Server` -> User.

2. User Request (API to :8081 for project management):

   - Hits `API Server`.
   - `API Server` interacts with `State Manager` to Create/Read/Update/Delete `Project Configurations`.

3. Background Monitoring (by State Manager):
   - `State Manager` monitors activity of `Running Container`s.
   - If inactive, `State Manager` tells `Container Manager` to stop the container via `Docker Engine`.

## Technical Details

- **Container Lifecycle**:

  - Containers are only started when needed and assigned dynamic host ports
  - A background process monitors for inactive containers
  - The system gracefully handles concurrent requests to start the same container
  - Containers are safely stopped during application shutdown

- **State Management**:
  - Project configurations are stored in memory
  - Container states include: idle, starting, running, stopping, stopped
  - Synchronization is handled with appropriate mutex locking

## Future Considerations

- Persistence for project registrations
- Resource limits for containers
- Health checks
- Support for multiple container replicas per project

## Next Steps

- **Caddy Support for Production:** Integrate Caddy as a reverse proxy for production deployments, leveraging its automatic HTTPS, HTTP/2, and robust features.
- **Cloudflare Integration for Automatic Domains:** Implement Cloudflare API integration to automatically create and assign a subdomain (e.g., `project-name.yourdomain.com`) when a new Luma project is registered. This would provide a Vercel-like experience for custom domains on a single server.

---

- **Persistence for Project Registrations:** Store project configurations in a database (e.g., SQLite, PostgreSQL, MySQL) or a file system to make registrations permanent across Luma restarts.
- **Resource Limits (CPU, Memory):** Implement resource controls for containers using Docker's options to prevent resource exhaustion and improve multi-tenancy.
- **Health Checks:** Add the ability to define and perform health checks (HTTP endpoints, commands) for containers to ensure they are healthy and ready before routing traffic.
- **Support for Multiple Container Replicas:** Extend Luma to run and manage multiple instances of a single project's container, incorporating a simple load balancing mechanism in the proxy.
- **Observability (Logging & Metrics):**
  - **Container Logging:** Capture and centralize logs from application containers.
  - **Luma Metrics:** Expose internal metrics (e.g., active containers, cold starts, request counts) via an endpoint (like Prometheus) for monitoring.
- **Authentication and Authorization for the API:** Secure the project registration/management API (port 8081) with an authentication and authorization layer.
- **Improved State Management Robustness:** Enhance the state manager to handle edge cases like container startup/shutdown failures or issues with the Docker daemon.
- **Configuration Management for Luma Itself:** Implement a system (config file, environment variables) for configuring Luma's core settings like ports, timeouts, and persistence options.
- **Graceful Shutdown Enhancements:** Ensure Luma properly stops all managed containers and saves state upon receiving a shutdown signal.
- **Web UI or CLI Tool:** Develop a command-line interface or a basic web user interface to simplify project management tasks.
- **Support for Container Start Arguments/Commands:** Allow users to specify custom commands or entrypoints when defining a project.
- **Networking Features:** Explore options for controlling container network access and potentially more complex internal networking within Luma.

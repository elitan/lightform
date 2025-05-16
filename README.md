# Luma - Open Source Cloud Run Alternative

Luma is a lightweight, open-source alternative to [Google Cloud Run](https://cloud.google.com/run), designed to demonstrate core "scale-to-zero" functionality. It automatically starts and stops Docker containers based on incoming HTTP requests, providing an efficient way to run your applications.

## Features

- **On-Demand Container Scaling**: Starts containers when traffic arrives and automatically stops them after a period of inactivity
- **Hostname-Based Routing**: Routes requests to the appropriate container based on the hostname
- **Docker Integration**: Seamlessly manages container lifecycle using the Docker SDK
- **Simple API**: Register projects with a straightforward API endpoint
- **Zero Configuration**: Minimal setup required to get started

## How it Works

Luma runs two server components:

1. **Proxy Server** (Port 8080) - Handles incoming requests to registered projects
2. **API Server** (Port 8081) - Admin API for managing project registrations

When a request arrives:

1. The reverse proxy identifies the target project based on the hostname
2. If the container isn't running, it's started on-demand
3. The request is proxied to the running container
4. After a period of inactivity (default 20 seconds), the container is stopped

## Prerequisites

- Go (version 1.21 or higher recommended)
- Docker installed and running

## Building and Running

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

## Project Structure

- `main.go` - Application entry point, initializes components and servers
- `api/` - API handlers for project registration
- `manager/` - Core business logic:
  - `container_manager.go` - Manages Docker container lifecycle
  - `state_manager.go` - Tracks project configurations and container states
- `proxy/` - HTTP reverse proxy that routes requests to containers
- `types/` - Core data models and interfaces

## System Architecture Diagram

```mermaid
graph TD
    subgraph User Interaction
        A[User sends HTTP request to myapp.localhost:8080]
        B["User sends API request to localhost:8081/projects (e.g., POST to register project)"]
    end

    subgraph Luma System
        C[Proxy Server :8080]
        D[API Server :8081]
        E[Reverse Proxy (proxy/reverse_proxy.go)]
        F[State Manager (manager/state_manager.go)]
        G[Container Manager (manager/container_manager.go)]
        H[Docker]
        I[Running Container (e.g., my-nginx-app)]
        J[Project Configurations (In-memory)]
    end

    A -- Request with Host header --> C
    C -- Identifies project via hostname --> E
    E -- Checks container status --> F
    F -- Reads project config --> J
    F -- If container not running --> G
    G -- Starts/Stops container --> H
    H -- Runs/Stops --> I
    E -- Proxies request --> I
    I -- Response --> E
    E -- Response --> C
    C -- Response --> A

    B -- Manages project --> D
    D -- Updates project config --> F
    F -- Stores/Retrieves --> J

    F -- Monitors container activity --> G
```

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

## Contributing

This project is primarily for demonstration purposes. Contributions and suggestions are welcome!

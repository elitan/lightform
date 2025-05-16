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

```
                               +-----------------------------+
                               |        User Interaction     |
                               +-----------------------------+
                                            |
                  +-------------------------+-------------------------+
                  |                                                 |
  [User sends HTTP request to myapp.localhost:8080]   [User sends API request to localhost:8081/projects]
                  |                                                 |
                  v                                                 v
+----------------------------------Luma System------------------------------------------+
|                                                                                         |
|   +-----------------+       +-----------------+      +-------------------------------+  |
|   | Proxy Server    |------>| Reverse Proxy   |<---->| State Manager                 |  |
|   | (Port 8080)     |       | (proxy/         |      | (manager/state_manager.go)    |  |
|   +-----------------+       |  reverse_proxy.go)|      |  - Manages Project Configs    |  |
|           ^                 +-----------------+      |  - Manages Container Status   |  |
|           |                         | ^              +-------------------------------+  |
|           |                         | |                         |         ^             |
|   (Response to User)                | | (Proxies Req/Resp)      |         | (Reads/Writes)
|           |                         | |                         v         |             |
|           |   +---------------------+ |              +-------------------------------+  |
|           |   | Running Container     |              | Container Manager             |  |
|           +---| (e.g., my-nginx-app)  |<-------------| (manager/container_manager.go)|  |
|               +---------------------+       Docker   |  - Starts/Stops Containers    |  |
|                       ^       |           <------> +-------------------------------+  |
|                       |       +------------------> H[Docker Engine]                    |
|                       +------------------------------+                                |
|                                                                                         |
|                                     +-----------------+                                 |
|                                     | API Server      |<--------------------------------+
|                                     | (Port 8081)     | (Updates Project Config)
|                                     +-----------------+                                 |
|                                                                                         |
+-----------------------------------------------------------------------------------------+

Legend:
--> : Data/Request Flow
<-->: Interaction/Query

Flow Breakdown:

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

## Contributing

This project is primarily for demonstration purposes. Contributions and suggestions are welcome!
```

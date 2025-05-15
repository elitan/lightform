# Luma - Simple Cloud Run Alternative (v1)

Luma is a lightweight, open-source alternative to Google Cloud Run, designed to demonstrate core "scale-to-zero" functionality. It starts and stops user-provided Docker containers based on incoming HTTP requests. This initial version focuses on simplicity and local execution.

## Goals (Version 1)

- Register a project with a Docker image and basic configuration.
- Listen for incoming HTTP requests and route them based on hostname.
- Automatically start a project's Docker container on the first request for that project.
- Forward the HTTP request to the running container.
- Automatically stop a project's Docker container if it's inactive for 1 minute.
- Provide a Go service that runs locally, suitable for use behind a reverse proxy like Caddy.

## Features

- **Project Registration API**: `POST /projects` endpoint to register new projects.
- **Request Handler**: Dynamically starts containers and proxies requests.
- **Container Manager**: Uses the Docker Go SDK to manage container lifecycle (run, stop).
- **State Manager**: In-memory storage for project configurations and container status.
- **Inactivity Monitor**: Background goroutine to stop idle containers.
- **Hostname-based Routing**: Uses the `Host` header to route requests.

## Prerequisites

- Go (version 1.21 or higher recommended)
- Docker installed and running

## Building and Running

1.  **Clone the repository (if you haven't already):**

    ```bash
    # git clone <repository-url>
    # cd luma
    ```

2.  **Ensure dependencies are downloaded:**

    ```bash
    go mod tidy
    ```

3.  **Build the executable (for a production-like build):**

    ```bash
    go build -o luma .
    ```

    Then run:

    ```bash
    ./luma
    ```

4.  **Run for local development:**

    A simpler way to run the service during development (compiles and runs in one step):

    ```bash
    go run main.go
    ```

    The service will start by default on port `8080`.

## Usage

### 1. Registering a Project

To register a project, send a `POST` request to the `/projects` endpoint.

**Example using `curl`:**

Let's say you have a simple Docker image `nginxdemos/hello` (a simple Nginx server that listens on port 80) and you want to make it accessible via `myapp.localhost`.

```bash
curl -X POST http://localhost:8080/projects -H "Content-Type: application/json" -d '{
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

- `name`: A unique name for your project.
- `docker_image`: The Docker image to run (e.g., `nginx:latest`, `your-custom-image`).
- `env_vars`: A map of environment variables (key-value pairs) to set in the container.
- `container_port`: The port your application inside the Docker container listens on.
- `hostname`: The hostname that Luma will use to route requests to this project.

### 2. Accessing Your Service

Once a project is registered, Luma will listen for requests matching the specified `hostname`.

- **First Request (Container Startup):**
  When the first request comes in for `http://myapp.localhost:8080` (or just `http://myapp.localhost` if you have a reverse proxy like Caddy set up to forward to `localhost:8080` based on the hostname), Luma will:

  1.  Recognize the `myapp.localhost` hostname.
  2.  See that the container for `my-nginx-app` is not running.
  3.  Pull the `nginxdemos/hello` image (if not already present).
  4.  Start a new container from this image, mapping its internal port `80` to a dynamic host port.
  5.  Forward the request to the newly started container.

- **Subsequent Requests:**
  As long as requests keep coming for `myapp.localhost` within the 1-minute inactivity window, they will be proxied directly to the already running container.

- **Scale-to-Zero (Inactivity Shutdown):**
  If no requests are made to `http://myapp.localhost:8080` for 1 minute, the inactivity monitor will automatically stop and remove the Docker container for `my-nginx-app` to save resources. The next request will trigger a new startup.

**Example using `curl` to access the service:**

```bash
curl -H "Host: myapp.localhost" http://localhost:8080
```

Or, if you have configured your `/etc/hosts` file to point `myapp.localhost` to `127.0.0.1` (or using a reverse proxy that handles this):

```bash
curl http://myapp.localhost:8080
```

You should see the Nginx welcome page from the `nginxdemos/hello` container.

## Architecture Overview

Luma consists of a single Go service that includes:

- An API endpoint for project registration.
- An HTTP listener that uses hostname-based routing.
- A state manager for in-memory project and container status.
- A container manager that interacts with the Docker daemon via the Go SDK.
- A reverse proxy to forward requests to running containers.
- A background goroutine for monitoring and shutting down inactive containers.

## Future Considerations

- Persistence for project registrations (e.g., Redis, file-based).
- Resource limits for containers.
- Basic health checks.
- Support for multiple container replicas per project.

## Contributing

This project is primarily for demonstration purposes. Contributions and suggestions are welcome!

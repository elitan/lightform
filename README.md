# Luma
Open Source Google Cloud Run Alternative

A serverless container management system that starts containers on-demand and automatically shuts them down after a period of inactivity.

## Features

- On-demand container deployment and scaling
- Auto-scale based on request load
- Inactivity timeout for idle containers (default: 10 minutes)
- Reverse proxy to route requests to containers
- Simple HTTP API to manage services

## Getting Started

### Prerequisites

- Go 1.21 or higher
- Docker 

### Installation

1. Clone the repository:

```bash
git clone https://github.com/elitan/luma.git
cd luma
```

2. Run the setup script:

```bash
./setup.sh
```

The setup script will:
- Build the Luma service
- Create a Docker network
- Start Caddy as a reverse proxy
- Start the Luma service

By default, Luma runs on port 8080 and Caddy proxies requests to it. You can customize the Luma service using the following flags:

- `-port`: HTTP server port (default: 8080)
- `-inactivity-timeout`: Container inactivity timeout (default: 10m)
- `-scale-threshold`: Request count threshold for scaling (default: 80)

Example:

```bash
./bin/luma -port=9000 -inactivity-timeout=5m -scale-threshold=50
```

## Usage

### Registering a Service

Register a service with a POST request to `/api/services`:

```bash
curl -X POST http://localhost:8080/api/services \
  -H "Content-Type: application/json" \
  -d '{
    "name": "nextjs-app",
    "image": "nextjs-app:latest",
    "minReplicas": 1,
    "maxReplicas": 10
  }'
```

### Listing Services

Get a list of running services:

```bash
curl -X GET http://localhost:8080/api/services
```

### Accessing a Service

Access a service directly through the proxy:

```bash
curl http://localhost:8080/nextjs-app/
```

If the service is not running, it will be started automatically. If there are a high number of concurrent requests, additional instances will be started automatically.

## Architecture

Luma consists of two main components:

1. **Luma Service**: Runs directly on the host to manage Docker containers.
2. **Caddy Server**: Runs in a Docker container as the front-facing web server.

```
                           ┌─────────────────┐
                           │                 │
  Internet ───────────────►│  Caddy Server   │
                           │  (Docker)       │
                           │                 │
                           └────────┬────────┘
                                    │
                                    ▼
                           ┌─────────────────┐
                           │                 │
                           │  Luma Service   │
                           │  (Host)         │
                           │                 │
                           └────────┬────────┘
                                    │
                                    ▼
              ┌───────────────────────────────────────┐
              │                                       │
              ▼                                       ▼
    ┌─────────────────┐                     ┌─────────────────┐
    │                 │                     │                 │
    │  Container 1    │         ...         │  Container N    │
    │  (Docker)       │                     │  (Docker)       │
    │                 │                     │                 │
    └─────────────────┘                     └─────────────────┘
```

## License

MIT
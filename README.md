# Luma
## Open Source Google Cloud Run Alternative

Luma is a lightweight, self-hosted platform that brings Google Cloud Run-like functionality to your own infrastructure. It automatically starts containers on-demand when requests arrive and shuts them down after a period of inactivity, saving resources and reducing costs.

## Features

- **Zero Cold Starts**: Containers start automatically when requests arrive
- **Pay Only for What You Use**: Containers shut down after inactivity (default: 10 minutes)
- **Auto-scaling**: Automatically scales based on concurrent request load
- **Simple Deployment**: Run on your own hardware, VM, or any cloud provider
- **Developer Friendly**: Simple HTTP API for service management
- **Open Source**: 100% open source, run it anywhere

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

If the service is not running, it will be started automatically - just like Google Cloud Run. The first request might take a few seconds to process while the container starts, but subsequent requests will be handled instantly. If concurrent request count exceeds your configured threshold, additional instances will be started automatically to handle the load.

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

## Why Luma?

Google Cloud Run provides a fantastic serverless container platform, but running it requires using Google Cloud. Luma brings the same powerful concept to your own infrastructure:

- **Cost Efficiency**: Only run containers when needed, save resources when traffic is low
- **Infrastructure Control**: Run on your own servers, VMs, or any cloud provider
- **No Vendor Lock-in**: Open source and portable
- **Simplified Operations**: Automatic scaling without complex Kubernetes configurations

## License

MIT
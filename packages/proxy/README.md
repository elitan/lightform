# Lightform Proxy

A high-performance reverse proxy with automatic HTTPS certificate management, designed for the Lightform deployment system.

## Features

- **Automatic HTTPS**: Automatic certificate acquisition and renewal via Let's Encrypt
- **Health Checking**: Built-in health checks for backend services
- **Blue-Green Deployments**: Seamless traffic switching between application versions
- **Multi-Project Support**: Handle multiple projects on the same host
- **State Persistence**: JSON-based state management that survives restarts
- **Docker Integration**: Seamless integration with Docker networks

## Architecture

The proxy consists of several components:

- **State Manager**: Manages persistent configuration in JSON
- **Certificate Manager**: Handles Let's Encrypt certificate lifecycle
- **Router**: Routes HTTP/HTTPS traffic to backend containers
- **Health Checker**: Monitors backend service health
- **CLI Interface**: Accepts commands from the Lightform CLI

## Building

### Local Development

```bash
# Install dependencies
go mod download

# Build the binary
go build -o lightform-proxy ./cmd/lightform-proxy

# Run tests
go test ./...
```

### Docker Build

```bash
docker build -t lightform-proxy .
```

## Running

### As a Container (Production)

```bash
docker run -d \
  --name lightform-proxy \
  --network lightform-global \
  -p 80:80 \
  -p 443:443 \
  -v lightform-proxy-data:/var/lib/lightform-proxy \
  lightform-proxy
```

### Local Development

```bash
# Run the proxy server
./lightform-proxy

# Or use go run
go run ./cmd/lightform-proxy
```

## CLI Commands

The proxy accepts commands via `docker exec`:

```bash
# Deploy a route
docker exec lightform-proxy lightform-proxy deploy \
  --host api.example.com \
  --target my-project-web:3000 \
  --project my-project \
  --health-path /up

# Remove a route
docker exec lightform-proxy lightform-proxy remove --host api.example.com

# List all routes
docker exec lightform-proxy lightform-proxy list

# Check certificate status
docker exec lightform-proxy lightform-proxy cert-status --host api.example.com

# Force certificate renewal
docker exec lightform-proxy lightform-proxy cert-renew --host api.example.com

# Enable Let's Encrypt staging mode (for testing)
docker exec lightform-proxy lightform-proxy set-staging --enabled true

# Switch traffic for blue-green deployment
docker exec lightform-proxy lightform-proxy switch \
  --host api.example.com \
  --target my-project-web-green:3000
```

## Configuration

### State File

The proxy maintains its state in `/var/lib/lightform-proxy/state.json`:

```json
{
  "projects": {
    "my-project": {
      "hosts": {
        "api.example.com": {
          "target": "my-project-web:3000",
          "app": "web",
          "health_path": "/up",
          "ssl_enabled": true,
          "certificate": {
            "status": "active",
            "expires_at": "2024-04-15T10:35:00Z"
          }
        }
      }
    }
  }
}
```

### Let's Encrypt Staging

For development and testing, enable Let's Encrypt staging mode:

```bash
docker exec lightform-proxy lightform-proxy set-staging --enabled true
```

This uses Let's Encrypt's staging environment which has much higher rate limits but issues untrusted certificates.

## Health Checks

The proxy performs health checks every 30 seconds on all configured backends. A backend is considered healthy if:

- The health check endpoint returns a 2xx status code
- The request completes within 5 seconds

Unhealthy backends are automatically removed from the routing pool.

## Certificate Management

### Acquisition

- Certificates are automatically acquired when a route is deployed with SSL enabled
- Uses HTTP-01 challenge validation
- Retries every 10 minutes for up to 24 hours on failure
- Respects Let's Encrypt rate limits

### Renewal

- Certificates are checked for renewal every 12 hours
- Renewal is attempted 30 days before expiry
- Failed renewals are retried with the same logic as acquisition

### Rate Limits

Let's Encrypt has strict rate limits:

- 50 certificates per registered domain per week
- 5 failed validations per account per hostname per hour

The proxy tracks and respects these limits automatically.

## Logging

All logs are written to stdout with structured prefixes:

- `[PROXY]`: General proxy operations
- `[CERT]`: Certificate management
- `[ACME]`: ACME challenge handling
- `[HEALTH]`: Health check results
- `[WORKER]`: Background worker status
- `[CLI]`: CLI command handling

View logs:

```bash
docker logs -f lightform-proxy
```

## Troubleshooting

### Certificate Acquisition Failures

1. Check DNS is properly configured:

   ```bash
   dig +short api.example.com
   ```

2. Verify the proxy is accessible on port 80:

   ```bash
   curl -I http://api.example.com/.well-known/acme-challenge/test
   ```

3. Check proxy logs for ACME validation attempts:
   ```bash
   docker logs lightform-proxy | grep ACME
   ```

### Health Check Failures

1. Test the health endpoint directly:

   ```bash
   docker exec lightform-proxy curl http://my-project-web:3000/up
   ```

2. Verify the container is on the correct network:
   ```bash
   docker network inspect my-project-network
   ```

### Blue-Green Deployment Issues

1. Verify both versions are running:

   ```bash
   docker ps | grep my-project-web
   ```

2. Check health status of both versions:
   ```bash
   docker exec lightform-proxy lightform-proxy list
   ```

## Development

### Running Tests

```bash
# Unit tests
go test ./internal/...

# Integration tests
go test -tags=integration ./test/...

# With coverage
go test -cover ./...
```

### Local Testing with Staging Certificates

1. Build and run locally:

   ```bash
   go build -o lightform-proxy ./cmd/lightform-proxy
   sudo ./lightform-proxy  # Needs root for ports 80/443
   ```

2. Enable staging mode:

   ```bash
   ./lightform-proxy set-staging --enabled true
   ```

3. Deploy a test route:
   ```bash
   ./lightform-proxy deploy \
     --host test.example.com \
     --target localhost:8080 \
     --project test
   ```

## Security

- Certificates and keys are stored with restricted permissions (0600)
- TLS configuration uses modern cipher suites and TLS 1.2+
- Health check endpoints should not expose sensitive information
- The proxy does not log request bodies or sensitive headers

## Performance

- Connection pooling for backend requests
- Efficient in-memory routing table
- Concurrent health checks
- Minimal overhead on request routing

## License

Part of the Lightform deployment system.

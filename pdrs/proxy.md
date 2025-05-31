# Luma Proxy Architecture - Ground Up Rewrite

## Overview

The Luma proxy serves as a reverse proxy with automatic HTTPS certificate management, tightly integrated with the Luma CLI deployment system. This document outlines the architectural plan for a complete rewrite.

## Core Responsibilities

1. **Traffic Routing**: Host-based routing of HTTP/HTTPS traffic to backend containers
2. **HTTPS Certificate Management**: Automatic acquisition, renewal, and management of Let's Encrypt certificates

## State Management

### Persistent State (JSON)

The proxy maintains a single JSON state file that survives host reboots and container restarts:

```json
{
  "projects": {
    "my-project": {
      "hosts": {
        "api.example.com": {
          "target": "my-project-web-blue:3000",
          "app": "web",
          "health_path": "/up",
          "created_at": "2024-01-15T10:30:00Z",
          "ssl_enabled": true,
          "ssl_redirect": true,
          "forward_headers": true,
          "response_timeout": "30s",
          "certificate": {
            "status": "active",
            "acquired_at": "2024-01-15T10:35:00Z",
            "expires_at": "2024-04-15T10:35:00Z",
            "last_renewal_attempt": "2024-01-15T10:35:00Z",
            "renewal_attempts": 0,
            "cert_file": "/var/lib/luma-proxy/certs/api.example.com/cert.pem",
            "key_file": "/var/lib/luma-proxy/certs/api.example.com/key.pem"
          }
        },
        "admin.example.com": {
          "target": "my-project-admin-green:3000",
          "app": "admin",
          "health_path": "/up",
          "created_at": "2024-01-15T10:30:00Z",
          "ssl_enabled": true,
          "ssl_redirect": true,
          "forward_headers": true,
          "response_timeout": "30s",
          "certificate": {
            "status": "acquiring",
            "first_attempt": "2024-01-15T10:30:00Z",
            "last_attempt": "2024-01-15T11:30:00Z",
            "next_attempt": "2024-01-15T11:35:00Z",
            "attempt_count": 18,
            "max_attempts": 144
          }
        }
      }
    },
    "blog-project": {
      "hosts": {
        "blog.example.com": {
          "target": "blog-project-web-blue:3000",
          "app": "web",
          "health_path": "/up",
          "created_at": "2024-01-15T09:00:00Z",
          "ssl_enabled": true,
          "ssl_redirect": true,
          "forward_headers": true,
          "response_timeout": "30s",
          "certificate": {
            "status": "active",
            "acquired_at": "2024-01-15T09:05:00Z",
            "expires_at": "2024-04-15T09:05:00Z",
            "cert_file": "/var/lib/luma-proxy/certs/blog.example.com/cert.pem",
            "key_file": "/var/lib/luma-proxy/certs/blog.example.com/key.pem"
          }
        }
      }
    }
  },
  "lets_encrypt": {
    "account_key_file": "/var/lib/luma-proxy/certs/account.key",
    "directory_url": "https://acme-v02.api.letsencrypt.org/directory",
    "email": "admin@example.com",
    "staging": false
  },
  "metadata": {
    "version": "2.0.0",
    "last_updated": "2024-01-15T11:30:00Z"
  }
}
```

### Non-Persistent State (Runtime Only)

- **Health Check Status**: Recalculated on startup, updated continuously
- **Connection Pools**: Rebuilt on startup

### State Persistence Strategy

The proxy maintains state in two layers:

1. **In-Memory State**: Fast lookup tables for request routing

   - Host → Config mappings for O(1) routing decisions
   - Certificate status and retry schedules
   - All state changes happen here first

2. **JSON File Persistence**: Asynchronous backup to disk
   - In-memory state is serialized to JSON every 60 seconds (if changed)
   - Atomic writes prevent corruption during updates
   - Used to restore in-memory state on startup

**Flow:**

- CLI command → In-memory state updated immediately → JSON saved async
- Certificate acquired → In-memory state updated → JSON saved async
- Proxy restart → JSON loaded → In-memory state rebuilt

This ensures fast request processing (no disk I/O in hot path) while maintaining persistence across restarts.

### File System Layout

```
/var/lib/luma-proxy/
├── state.json                    # Main state file
└── certs/
    ├── account.key              # Let's Encrypt account key
    ├── api.example.com/
    │   ├── cert.pem            # Certificate
    │   ├── key.pem             # Private key
    │   └── chain.pem           # Certificate chain
    └── other.example.com/
        ├── cert.pem
        ├── key.pem
        └── chain.pem
```

## Certificate Management Strategy

### Acquisition Workflow

1. **Immediate Attempt**: When a route is deployed with SSL enabled, immediately attempt certificate acquisition
2. **Retry Logic**: If initial attempt fails:

   - Retry every 10 minutes for 24 hours
   - Total: 144 attempts over 24 hours
   - Respect Let's Encrypt rate limits (5 failures per account, per hostname, per hour)

3. **Rate Limit Handling**:
   - Track failed attempts per hostname per hour
   - Back off when approaching rate limits
   - Log rate limit encounters prominently

### Renewal Workflow

1. **Renewal Schedule**: Check for certificates expiring within 30 days, every 12 hours
2. **Renewal Process**:
   - Attempt renewal 30 days before expiry
   - If renewal fails, retry using same logic as acquisition
   - Log all renewal attempts and outcomes

### Certificate States

- `pending`: Route configured, certificate acquisition queued
- `acquiring`: Actively attempting to acquire certificate
- `active`: Certificate acquired and valid
- `renewing`: Certificate renewal in progress
- `failed`: Acquisition failed after max attempts (serve HTTP only)
- `expired`: Certificate expired (attempt renewal, serve HTTP only)

### Let's Encrypt Staging Environment

For development and testing, the proxy supports Let's Encrypt's staging environment:

- **Production**: `https://acme-v02.api.letsencrypt.org/directory` (strict rate limits)
- **Staging**: `https://acme-staging-v02.api.letsencrypt.org/directory` (generous rate limits)

**Benefits of staging mode:**

- Much higher rate limits (ideal for testing)
- Same ACME protocol as production
- Certificates issued but not trusted by browsers
- Perfect for testing certificate acquisition/renewal logic

**Configuration via luma.yml:**

```yaml
proxy:
  lets_encrypt_staging: true # Enable staging mode
```

When staging mode is enabled, the proxy automatically uses the staging directory URL and marks certificates appropriately for development use.

## Integration with Luma CLI

### DNS Alias Strategy

The Luma CLI deploys containers with dual Docker network aliases to handle multi-project scenarios:

1. **Generic Alias**: `${app}` (e.g., `web`) - for internal project communication within the same Docker network
2. **Project-Specific Alias**: `${project}-${app}` (e.g., `gmail-web`, `blog-web`) - globally unique across all projects

**The proxy MUST use the project-specific alias** to avoid conflicts when multiple projects have apps with the same name (e.g., both `gmail` and `blog` projects having a `web` app).

**Example**:

- Project `gmail` with app `web` → DNS alias: `gmail-web`
- Project `blog` with app `web` → DNS alias: `blog-web`
- Proxy routes to: `gmail-web:3000` and `blog-web:3000` respectively

This ensures that `api.gmail.com` routes to `gmail-web:3000` and `blog.example.com` routes to `blog-web:3000` without any DNS conflicts.

### Blue-Green Deployment Integration

The proxy plays a critical role in zero-downtime deployments by managing traffic switching between application versions:

**Container Alias Strategy:**
Each container gets two DNS aliases for different purposes:

```
Blue Container Aliases:
- web                    # Internal project communication
- gmail-web-blue        # Proxy-specific routing target

Green Container Aliases:
- web                    # Internal project communication
- gmail-web-green       # Proxy-specific routing target
```

**Deployment Flow:**

1. **Blue Version Running**: Proxy routes `api.gmail.com` → `gmail-web-blue:3000`
2. **Green Version Deployed**: New container starts with `gmail-web-green` alias
3. **Health Check Phase**: Proxy health-checks `gmail-web-green:3000` specifically
4. **Traffic Switch**: CLI calls `luma-proxy switch --host api.gmail.com --target gmail-web-green:3000`
5. **Blue Cleanup**: Old blue container stopped, proxy now routes to green

**Key Integration Points:**

- **Precise Routing**: Proxy routes to specific version (`gmail-web-blue` vs `gmail-web-green`)
- **Health Checking**: Proxy can health-check specific version before switching traffic
- **Internal Communication**: Services use simple aliases (`web`) within the project
- **Zero-Downtime Control**: Proxy switches traffic atomically between specific targets

**Network Behavior:**

- **Internal traffic**: Load balances between blue/green (acceptable for internal services)
- **External traffic**: Precisely routed to active version via proxy
- **Health isolation**: Each version can be health-checked independently
- **Clean switching**: No DNS propagation delays, instant traffic switch

This design gives the proxy precise control over external traffic while maintaining simple internal service communication.

### Docker Network Strategy

The proxy must connect to multiple Docker networks to reach containers across different projects:

**Network Architecture:**

- **Global Network**: `luma-global` - where the proxy container lives
- **Project Networks**: `gmail-network`, `blog-network`, etc. - where project containers live
- **Dynamic Connections**: Proxy connects to project networks as projects are deployed

**Current Implementation (from CLI):**

1. **Setup Phase**: CLI creates global `luma-global` network and deploys proxy to it
2. **Project Deploy**: CLI creates project-specific network (e.g., `gmail-network`)
3. **Container Deployment**: App containers join their project network with dual aliases
4. **Network Connection**: CLI connects proxy to the project network dynamically

**Network Access Pattern:**

```bash
# Proxy can reach any project container via project-specific alias
gmail-web:3000     # Reaches gmail project's web container
blog-web:3000      # Reaches blog project's web container
my-api-api:8080    # Reaches my-api project's api container
```

**Dynamic Network Management:**

- **Project Creation**: `docker network connect gmail-network luma-proxy`
- **Project Removal**: `docker network disconnect gmail-network luma-proxy`
- **Health Checks**: Proxy can reach `gmail-web:3000` because it's connected to `gmail-network`
- **Routing**: All traffic routing works through these network connections

This allows the proxy to route traffic to any deployed project while maintaining network isolation between projects.

### CLI Commands Handled

The proxy accepts these commands from the CLI via container exec:

```bash
# Deploy/update a route
luma-proxy deploy --host api.example.com --target my-project-web:3000 --project my-project --health-path /up

# Remove a route
luma-proxy remove --host api.example.com

# List all routes
luma-proxy list

# Update health status (used by CLI health checks)
luma-proxy updatehealth --host api.example.com --healthy true|false

# Certificate status
luma-proxy cert-status --host api.example.com

# Force certificate renewal
luma-proxy cert-renew --host api.example.com

# Configure Let's Encrypt staging mode (for development/testing)
luma-proxy set-staging --enabled true|false

# Switch traffic between blue/green deployments
luma-proxy switch --host api.example.com --target my-project-web-green:3000
```

### CLI Integration Points

1. **Setup Phase** (`luma setup`):

   - CLI deploys proxy container with mounted volumes
   - Proxy starts with empty state, begins serving

2. **Deploy Phase** (`luma deploy`):

   - CLI calls `luma-proxy deploy` for each app with proxy config
   - Proxy updates routing state and initiates certificate acquisition
   - CLI monitors health checks and calls `updatehealth` as needed

3. **Status Phase** (`luma status`):
   - CLI calls `luma-proxy list` to show routing status
   - CLI calls `luma-proxy cert-status` to show certificate status

## Proxy Server Architecture

### Core Components

1. **HTTP/HTTPS Server**:

   - HTTP server on port 80 (redirects to HTTPS, serves ACME challenges)
   - HTTPS server on port 443 (main traffic routing)
   - Management API on Unix socket

2. **State Manager**:

   - Loads/saves JSON state file
   - Handles atomic updates to prevent corruption
   - Provides thread-safe access to state

3. **Certificate Manager**:

   - ACME client for Let's Encrypt integration
   - Background worker for acquisition/renewal attempts
   - File system management for certificates

4. **Router**:

   - Host-based request routing
   - Health check integration
   - Connection pooling to backends

5. **Health Checker**:
   - Periodic health checks to backend services
   - Configurable health check paths
   - Automatic failover (if multiple replicas exist)

### Startup Sequence

1. Load state from JSON file (create if doesn't exist)
2. Validate certificate files exist and match state
3. Start health checking for all configured routes
4. Start certificate renewal background worker
5. Start HTTP server (port 80)
6. Start HTTPS server (port 443) with available certificates
7. Start management API (Unix socket)

### Background Workers

1. **Certificate Acquisition Worker**:

   - Processes pending certificate requests
   - Implements retry logic with exponential backoff
   - Respects rate limits

2. **Certificate Renewal Worker**:

   - Checks for certificates expiring within 30 days
   - Runs every 12 hours
   - Attempts renewal for expiring certificates

3. **Health Check Worker**:

   - Performs health checks every 30 seconds
   - Updates routing decisions based on health status
   - Does NOT persist health status (recalculated on restart)

4. **State Persistence Worker**:
   - Saves state to JSON file every 60 seconds if changes detected
   - Atomic writes to prevent corruption

## Error Handling & Logging

All logs are written to stdout/stderr with structured formatting for easy debugging:

### Certificate Acquisition Logging

All certificate operations and ACME challenge requests are logged with full detail for debugging:

**Certificate Acquisition Process:**

```
2024-01-15T10:30:00Z [CERT] [api.example.com] Starting certificate acquisition
2024-01-15T10:30:01Z [CERT] [api.example.com] ACME challenge created: http-01
2024-01-15T10:30:01Z [CERT] [api.example.com] Challenge URL: /.well-known/acme-challenge/abc123def456
2024-01-15T10:30:02Z [ACME] [api.example.com] Let's Encrypt validation request: GET /.well-known/acme-challenge/abc123def456
2024-01-15T10:30:02Z [ACME] [api.example.com] Challenge response served: 200 OK
2024-01-15T10:30:03Z [CERT] [api.example.com] ACME challenge validation successful
2024-01-15T10:30:04Z [CERT] [api.example.com] Certificate issued successfully
```

**Certificate Acquisition Failures:**

```
2024-01-15T10:30:00Z [CERT] [api.example.com] Starting certificate acquisition
2024-01-15T10:30:01Z [CERT] [api.example.com] ACME challenge created: http-01
2024-01-15T10:30:01Z [CERT] [api.example.com] Challenge URL: /.well-known/acme-challenge/xyz789abc123
2024-01-15T10:30:05Z [ACME] [api.example.com] Let's Encrypt validation timeout (no request received)
2024-01-15T10:30:05Z [CERT] [api.example.com] DNS validation failed: NXDOMAIN
2024-01-15T10:30:05Z [CERT] [api.example.com] Acquisition failed, scheduling retry in 10 minutes
2024-01-15T10:30:05Z [CERT] [api.example.com] Attempt 1/144, next attempt: 2024-01-15T10:40:00Z
```

**ACME Challenge Handling:**

- **Internal Processing**: Proxy serves `/.well-known/acme-challenge/*` requests directly
- **Request Routing**: All other requests route to backend applications
- **Challenge Logging**: Every Let's Encrypt validation request is logged
- **Debug Information**: Full challenge URLs and response codes logged

### Health Check Logging

Health check results are logged for operational visibility:

```
2024-01-15T10:30:00Z [HEALTH] [api.example.com] Check passed: 200 OK (15ms)
2024-01-15T10:30:30Z [HEALTH] [api.example.com] Check failed: connection refused
2024-01-15T10:31:00Z [HEALTH] [api.example.com] Check passed: 200 OK (12ms)
```

### Request Logging

HTTP requests are logged for debugging and monitoring:

```
2024-01-15T10:30:00Z [PROXY] api.example.com GET /api/users -> my-project-web:3000 200 (45ms)
2024-01-15T10:30:01Z [PROXY] api.example.com POST /api/auth -> my-project-web:3000 401 (12ms)
```

### Accessing Logs

```bash
# View all proxy logs
docker logs luma-proxy

# Follow logs in real-time
docker logs -f luma-proxy

# View recent logs
docker logs --tail 100 luma-proxy
```

## Implementation Technology

- **Language**: Go (for performance, ACME library ecosystem, and container efficiency)
- **ACME Library**: golang.org/x/crypto/acme for Let's Encrypt integration
- **HTTP Server**: Standard library net/http with custom routing
- **JSON Handling**: Standard library encoding/json
- **Logging**: Structured logging with configurable levels
- **Testing**: Comprehensive unit tests, integration tests with mock ACME server

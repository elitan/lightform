# Luma Packages

This directory contains the core packages for the Luma deployment system:

## Structure

- **`cli/`** - TypeScript CLI for managing deployments
  - Zero-downtime deployments via SSH
  - Blue-green deployment strategy
  - Docker container management
  - Proxy configuration

- **`proxy/`** - Go-based reverse proxy service
  - Automatic HTTPS with Let's Encrypt
  - Health checking
  - Dynamic routing
  - State persistence

- **`shared/`** - Shared configurations and types (future use)

## Development

### CLI Package

```bash
cd packages/cli
bun install
bun run build
bun test
```

### Proxy Package

```bash
cd packages/proxy
go mod download
go build -o dist/luma-proxy ./cmd/luma-proxy
go test ./...
```

## Building

From the root directory:

```bash
# Build everything
bun run build

# Build specific packages
bun run build:cli
bun run build:proxy
```

## Testing

From the root directory:

```bash
# Test everything
bun test

# Test specific packages
bun test:cli
```
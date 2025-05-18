# Luma Proxy

A lightweight HTTP/HTTPS reverse proxy with host-based routing.

## Features

- HTTP to HTTPS redirection
- Host-based routing
- Dynamic service configuration
- Project-based isolation for multi-project deployments

## Usage

### Running the proxy

```
luma-proxy run [--port <https_port>] [--socket-path <path>] [--cert-email <email>]
```

Options:

- `--port`: HTTPS port to listen on (default: 443)
- `--socket-path`: Path to the Unix domain socket for management
- `--cert-email`: Email address for Let's Encrypt registration (recommended)

### Configuring routing

```
luma-proxy deploy --host <hostname> --target <ip:port> [--project <project-name>]
```

Options:

- `--host`: Hostname that this service will serve traffic for
- `--target`: Target service address in the format ip:port
- `--project`: Project identifier, useful for distinguishing services in different Docker networks (default: "default")

## Examples

### Start the proxy

```
luma-proxy run --cert-email admin@example.com
```

### Configure routing for an application

```
luma-proxy deploy --host api.example.com --target localhost:3000 --project my-webapp
```

### Configure routing for another application in a different project

```
luma-proxy deploy --host api2.example.com --target localhost:3000 --project my-other-app
```

## SSL Certificates

Luma Proxy automatically obtains and manages SSL certificates using Let's Encrypt. The proxy will:

1. Obtain certificates for all configured hostnames.
2. Automatically renew certificates before they expire (typically 30 days before expiry).
3. Handle Let's Encrypt ACME challenges (HTTP-01).

Certificates are stored by default in `/var/lib/luma-proxy/certs` inside the container.

**Important notes:**

- Your server must be accessible from the internet on ports 80 and 443.
- DNS records for your domains must point to your server.
- Providing an email address via `--cert-email` is highly recommended for certificate expiry notifications from Let's Encrypt.

## Integration with Luma CLI

When deploying applications with Luma CLI, it automatically configures the Luma Proxy to route traffic to your containers. The proxy handles:

- Routing requests based on hostname to the appropriate container
- HTTP to HTTPS redirection
- TLS termination (with automatic Let's Encrypt certificates)

## Building from source

```
go build -o luma-proxy ./cmd/luma-proxy
```

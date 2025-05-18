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
luma-proxy run [--port <https_port>] [--socket-path <path>]
```

Options:

- `--port`: HTTPS port to listen on (default: 443)
- `--socket-path`: Path to the Unix domain socket for management

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
luma-proxy run
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

The proxy requires SSL certificates for HTTPS. By default, it looks for:

- `cert.pem`: SSL certificate
- `key.pem`: SSL key

You can generate a self-signed certificate for testing:

```
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes
```

For production, you should use proper certificates from a trusted CA.

## Integration with Luma CLI

When deploying applications with Luma CLI, it automatically configures the Luma Proxy to route traffic to your containers. The proxy handles:

- Routing requests based on hostname to the appropriate container
- HTTP to HTTPS redirection
- TLS termination

## Building from source

```
go build -o luma-proxy ./cmd/luma-proxy
```

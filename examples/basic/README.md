# Basic Go + iop Deployment Example

This is a simple Go web application that demonstrates zero-downtime deployments using [iop](https://github.com/elitan/iop), including both an app and a PostgreSQL database service.

## 🚀 Quick Start with iop

### 1. Development Setup

Install Go dependencies and run locally:

```bash
go mod tidy
go run main.go
```

The server will start on port 3000. Visit [http://localhost:3000](http://localhost:3000) to see "Hello World 2".

### 2. Configure Your Server

**Important**: If you cloned this example, you need to update the server configuration:

1. Edit `iop.yml` and replace `157.180.47.213` with your actual server IP or domain
2. Update any domain references in `.iop/secrets` if applicable

### 3. Deploy with iop

This example includes a complete iop configuration for zero-downtime deployment:

```bash
iop
```

## 🆚 Why This Example?

This basic example demonstrates:

- **Simple Go web server** - Minimal HTTP server with health checks
- **Multi-stage Docker builds** - Optimized for Go applications
- **Database integration** - PostgreSQL as a supporting service
- **Environment management** - Both plain and secret variables
- **Zero-downtime deployments** - Blue-green deployment for the web app
- **Service persistence** - Database with persistent volumes

Perfect for understanding iop's core concepts with a minimal setup!

## 📚 Learn More

### Go Resources

- [Go Documentation](https://golang.org/doc/) - Official Go documentation
- [Go Web Programming](https://golang.org/doc/articles/wiki/) - Building web applications with Go

### iop Resources

- [iop Documentation](https://github.com/elitan/iop) - Zero-downtime Docker deployments
- [iop Examples](https://github.com/elitan/iop/tree/main/examples) - More deployment examples

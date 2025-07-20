# Basic Go + Lightform Deployment Example

This is a simple Go web application that demonstrates zero-downtime deployments using [Lightform](https://github.com/elitan/lightform), including both an app and a PostgreSQL database service.

## 🚀 Quick Start with Lightform

### 1. Development Setup

Install Go dependencies and run locally:

```bash
go mod tidy
go run main.go
```

The server will start on port 3000. Visit [http://localhost:3000](http://localhost:3000) to see "Hello World 2".

### 2. Deploy with Lightform

This example includes a complete Lightform configuration for zero-downtime deployment:

```bash
# Set up your servers
iop setup

# Deploy with zero downtime!
iop deploy
```

## 🆚 Why This Example?

This basic example demonstrates:

- **Simple Go web server** - Minimal HTTP server with health checks
- **Multi-stage Docker builds** - Optimized for Go applications
- **Database integration** - PostgreSQL as a supporting service
- **Environment management** - Both plain and secret variables
- **Zero-downtime deployments** - Blue-green deployment for the web app
- **Service persistence** - Database with persistent volumes

Perfect for understanding Lightform's core concepts with a minimal setup!

## 📚 Learn More

### Go Resources

- [Go Documentation](https://golang.org/doc/) - Official Go documentation
- [Go Web Programming](https://golang.org/doc/articles/wiki/) - Building web applications with Go

### Lightform Resources

- [Lightform Documentation](https://github.com/elitan/lightform) - Zero-downtime Docker deployments
- [Lightform Examples](https://github.com/elitan/lightform/tree/main/examples) - More deployment examples

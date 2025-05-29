# Basic Go + Luma Deployment Example

This is a simple Go web application that demonstrates zero-downtime deployments using [Luma](https://github.com/elitan/luma), including both an app and a PostgreSQL database service.

## 🚀 Quick Start with Luma

### 1. Development Setup

Install Go dependencies and run locally:

```bash
go mod tidy
go run main.go
```

The server will start on port 3000. Visit [http://localhost:3000](http://localhost:3000) to see "Hello World 2".

### 2. Deploy with Luma

This example includes a complete Luma configuration for zero-downtime deployment:

```bash
# Set up your servers
luma setup

# Deploy with zero downtime!
luma deploy
```

## 🆚 Why This Example?

This basic example demonstrates:

- **Simple Go web server** - Minimal HTTP server with health checks
- **Multi-stage Docker builds** - Optimized for Go applications
- **Database integration** - PostgreSQL as a supporting service
- **Environment management** - Both plain and secret variables
- **Zero-downtime deployments** - Blue-green deployment for the web app
- **Service persistence** - Database with persistent volumes

Perfect for understanding Luma's core concepts with a minimal setup!

## 📚 Learn More

### Go Resources

- [Go Documentation](https://golang.org/doc/) - Official Go documentation
- [Go Web Programming](https://golang.org/doc/articles/wiki/) - Building web applications with Go

### Luma Resources

- [Luma Documentation](https://github.com/elitan/luma) - Zero-downtime Docker deployments
- [Luma Examples](https://github.com/elitan/luma/tree/main/examples) - More deployment examples

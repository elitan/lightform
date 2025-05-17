# Luma Project Reference

Luma is an open-source alternative to Google Cloud Run that automatically manages Docker containers based on incoming HTTP requests. It follows a "scale-to-zero" approach where containers start on demand and stop after inactivity.

## System Architecture

### Main Components:
- **Proxy Server (port 8080)** - Routes external requests to containers
- **API Server (port 8081)** - Handles project registration

### Key Components:
- **StateManager** - Tracks project configurations and container states
- **ContainerManager** - Handles Docker container lifecycle (start/stop)
- **ReverseProxyHandler** - Routes requests and manages container lifecycle
- **ProjectHandler** - Provides API for registering projects

### Project Structure:
- `main.go` - Application entry point
- `api/` - API handlers
- `manager/` - Core business logic
- `proxy/` - HTTP reverse proxy
- `types/` - Core data models

## Workflow:
1. Users register projects via API
2. Requests come in via hostname (e.g., myapp.localhost)
3. System starts container if not running
4. Requests are proxied to the container
5. Containers shut down after inactivity (20s default)

## States:
- `idle` - Initial state
- `starting` - Container is being started
- `running` - Container is active
- `stopping` - Container is being stopped
- `stopped` - Container has been stopped

## API:
To register a project:
```bash
curl -X POST http://localhost:8081/projects -H "Content-Type: application/json" -d '{
  "name": "my-app",
  "docker_image": "image-name",
  "env_vars": {"KEY": "VALUE"},
  "container_port": 80,
  "hostname": "myapp.localhost"
}'
```

## Future Plans:
- Persistence for project registrations
- Resource limits for containers
- Health checks
- Multiple container replicas
- Authentication
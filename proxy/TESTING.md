# Testing Guide for Multi-Project Container Isolation

This guide provides various testing approaches to validate the network-aware routing solution locally before deploying to production.

## Quick Start

```bash
# Navigate to the proxy directory
cd proxy

# Run the quick DNS test (2-3 minutes)
./test-network-dns.sh

# Run the full integration test (5-10 minutes)
./test-multi-project-isolation.sh

# Run unit tests (seconds)
go test ./internal/service/
```

## Test Types

### 1. Unit Tests (`internal/service/manager_test.go`)

**What it tests**: Core service manager logic without Docker dependencies
**Runtime**: < 1 second
**Use case**: Quick validation during code changes

```bash
# Run all unit tests
go test ./internal/service/

# Run specific test
go test ./internal/service/ -run TestMultiProjectIsolation

# Run with verbose output
go test -v ./internal/service/

# Run benchmarks
go test -bench=. ./internal/service/
```

**Coverage**:

- ✅ Service registration and lookup
- ✅ Multi-project isolation logic
- ✅ Health status management
- ✅ Conflict detection
- ✅ Configuration management

### 2. Network DNS Test (`test-network-dns.sh`)

**What it tests**: Docker's network-scoped DNS resolution behavior
**Runtime**: 2-3 minutes
**Use case**: Understanding DNS behavior and validation

```bash
./test-network-dns.sh
```

**Coverage**:

- ✅ Network-scoped DNS resolution
- ✅ Load balancing within networks
- ✅ Cross-network isolation
- ✅ Docker's network precedence rules

**Key Insights**:

- Docker picks one network when a container is connected to multiple networks with same service aliases
- Load balancing works within the chosen network
- Direct container names work across networks

### 3. Full Integration Test (`test-multi-project-isolation.sh`)

**What it tests**: Complete proxy functionality with real containers
**Runtime**: 5-10 minutes
**Use case**: End-to-end validation before production deployment

```bash
./test-multi-project-isolation.sh
```

**Coverage**:

- ✅ Proxy build and startup
- ✅ Multi-project network creation
- ✅ Service discovery and routing
- ✅ Health check functionality
- ✅ Load balancing verification
- ✅ Configuration management

## Test Scenarios

### Scenario 1: Basic Multi-Project Isolation

```bash
# This test verifies that two projects can use the same service names
# without interfering with each other

Project A: test-project-a.local → web:3000 (in project-a-network)
Project B: test-project-b.local → web:3000 (in project-b-network)

Expected: Both work independently with proper isolation
```

### Scenario 2: Load Balancing Within Projects

```bash
# This test verifies Docker's built-in load balancing works within project networks

Project A: 2 replicas of web:3000 with same network alias
Expected: Requests distribute across both replicas
```

### Scenario 3: Health Check Isolation

```bash
# This test verifies health checks work with network-scoped DNS

Project A: Health check → http://web:3000/api/health (via project-a-network)
Project B: Health check → http://web:3000/api/health (via project-b-network)

Expected: Each health check reaches the correct project's containers
```

## Development Workflow

1. **Make code changes** to the proxy
2. **Run unit tests** for immediate feedback:
   ```bash
   go test ./internal/service/
   ```
3. **Run network DNS test** to verify Docker behavior:
   ```bash
   ./test-network-dns.sh
   ```
4. **Run full integration test** before committing:
   ```bash
   ./test-multi-project-isolation.sh
   ```
5. **Deploy to production** with confidence

## Debugging Failed Tests

### Unit Test Failures

- Check test output for specific assertion failures
- Use `go test -v` for detailed output
- Verify test data setup matches expected behavior

### Network DNS Test Failures

- Ensure Docker is running and accessible
- Check if ports 3000 are available
- Verify Docker supports custom networks
- Look for network creation/cleanup issues

### Integration Test Failures

- Check Docker build process for proxy image
- Verify all required ports are available (8443, 8080)
- Look for container startup issues in Docker logs
- Check network connectivity between containers

### Common Issues

**"Network already exists"**: Previous test cleanup failed

```bash
# Manual cleanup
docker network rm dns-test-project-a dns-test-project-b 2>/dev/null || true
```

**"Port already in use"**: Another service using test ports

```bash
# Check what's using the port
lsof -i :8443
```

**"Docker daemon not running"**: Docker service issue

```bash
# Start Docker (macOS)
open -a Docker

# Start Docker (Linux)
sudo systemctl start docker
```

## Performance Benchmarks

Run benchmarks to ensure performance doesn't degrade:

```bash
# Service lookup performance
go test -bench=BenchmarkFindByHost ./internal/service/

# Memory usage analysis
go test -benchmem -bench=. ./internal/service/
```

## CI/CD Integration

These tests are designed to run in CI environments:

```yaml
# Example GitHub Actions
- name: Run Unit Tests
  run: cd proxy && go test ./internal/service/

- name: Run Network DNS Test
  run: cd proxy && ./test-network-dns.sh

- name: Run Integration Test
  run: cd proxy && ./test-multi-project-isolation.sh
```

## Next Steps

After all tests pass locally:

1. Commit your changes
2. Deploy to staging environment
3. Run production tests using the examples
4. Monitor health checks and routing in production

## Test Coverage Goals

- **Unit Tests**: 90%+ coverage of service manager logic
- **Integration Tests**: All critical paths covered
- **Performance Tests**: No regression in lookup times
- **End-to-End Tests**: Real-world scenarios validated

The testing strategy ensures fast feedback during development while providing confidence that the multi-project isolation solution works correctly in all scenarios.

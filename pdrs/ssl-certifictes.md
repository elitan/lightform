# SSL Certificate Management PRD

## Problem Statement

The Luma proxy currently handles SSL certificates through Let's Encrypt integration, but we need to ensure the implementation is optimal, reliable, and fully functional for production deployments. SSL certificate issues can cause service outages and security vulnerabilities.

## How SSL Certificates Work Today

### Current Implementation Overview

The Luma proxy uses a **hybrid approach** for SSL certificate management:

1. **On-Demand Certificate Provisioning**: The proxy uses Go's `autocert` package which automatically provisions certificates when the first HTTPS request comes in for a new domain
2. **Background Retry Queue**: Domains are added to a retry queue during deployment for background processing
3. **Automatic Renewal**: Certificates auto-renew 30 days before expiry via `autocert`

### Certificate Flow

**During Deployment (`luma-proxy deploy`):**

1. Route is configured for the hostname
2. Domain is added to a **background retry queue** with the provided email
3. Deployment completes immediately (no waiting for certificates)
4. SSL certificate provisioning happens **on-demand** when first request arrives

**Background Processing:**

- A background service runs every 5 minutes
- Processes domains in the retry queue by adding them to the `autocert` allowed domains list
- Removes successfully processed domains from the queue
- Max 24 retry attempts (2 hours) before giving up

**Certificate Provisioning:**

- Uses Let's Encrypt HTTP-01 challenge via `autocert`
- Certificates stored in `/var/lib/luma-proxy/certs`
- Automatic renewal 30 days before expiry
- Host policy prevents certificate issuance for non-configured domains

### Key Components

**Certificate Manager (`cert/manager.go`):**

- Wraps Go's `autocert.Manager`
- Manages allowed domains list
- Integrates with retry queue
- Handles background processing

**Retry Queue (`cert/queue.go`):**

- Persistent JSON file storage at `/tmp/luma-proxy-cert-queue.json`
- 5-minute delay between retry attempts
- Max 24 attempts per domain
- Automatic cleanup of failed domains

**Command Integration:**

- `luma-proxy run`: Starts proxy with certificate manager
- `luma-proxy deploy`: Adds domains to retry queue
- `luma-proxy status`: Shows retry queue status

### Current Strengths

- ✅ Fast deployments (no waiting for certificates)
- ✅ Automatic renewal with `autocert`
- ✅ Rate limit resilience (retry queue)
- ✅ Host policy prevents unauthorized certificate requests
- ✅ Persistent retry queue survives proxy restarts

### Current Limitations

- ❌ First visitors may see SSL errors during provisioning
- ❌ Limited visibility into certificate status
- ❌ No proactive certificate health monitoring
- ❌ Retry queue status not easily accessible
- ❌ No certificate expiry warnings before auto-renewal

## Current State

Based on the existing proxy implementation:

- **Automatic Let's Encrypt certificates** are supported
- **HTTP to HTTPS redirection** is implemented
- **Host-based routing** with SSL termination
- **Multi-project isolation** for certificate management

### Known Issues & Gaps

- Certificate renewal reliability is uncertain
- No visibility into certificate status/expiry
- Limited error handling for certificate failures
- No fallback mechanisms for certificate issues
- Unclear behavior during certificate provisioning delays

## Requirements

### 1. Certificate Lifecycle Management

- **Automatic provisioning** of SSL certificates for new hosts
- **Automatic renewal** of certificates before expiry (< 30 days)
- **Graceful handling** of renewal failures with retry logic
- **Certificate cleanup** when hosts are removed

### 2. Monitoring & Observability

- **Health check endpoint** that includes certificate status
- **Expiry monitoring** with clear warnings before expiration
- **Certificate validation** checks (proper chain, not revoked)
- **Logging** of all certificate operations (provision, renew, fail)

### 3. Error Handling & Resilience

- **Fallback behavior** when certificates fail to provision
- **Rate limiting awareness** for Let's Encrypt API limits
- **Retry mechanisms** with exponential backoff
- **Self-healing** for corrupted certificate states

### 4. Security & Best Practices

- **TLS 1.2+ only** with secure cipher suites
- **HSTS headers** for enhanced security
- **Certificate pinning** considerations
- **Secure storage** of private keys

### 5. Operational Requirements

- **Zero-downtime** certificate updates
- **Multi-domain support** (SAN certificates when beneficial)
- **Wildcard certificate** support for subdomains
- **Manual certificate** upload option for custom certificates

## Success Criteria

### Functional

- ✅ New deployments automatically get valid SSL certificates within 5 minutes
- ✅ Certificates auto-renew without service interruption
- ✅ Certificate status is visible via `/luma-proxy/health` endpoint
- ✅ Failed certificate operations don't break existing services

### Non-Functional

- ✅ 99.9% uptime for SSL certificate availability
- ✅ Certificate provisioning completes in < 5 minutes
- ✅ Renewal operations complete in < 2 minutes
- ✅ Zero manual intervention required for standard operations

### Operational

- ✅ Clear error messages for certificate issues
- ✅ Proper logging for debugging certificate problems
- ✅ Self-recovery from transient Let's Encrypt API issues
- ✅ Graceful degradation when certificates are unavailable

## Testing Strategy

### Automated Testing

- Certificate provisioning for new hosts
- Certificate renewal simulation
- Failure scenario testing (API limits, network issues)
- Multi-domain certificate handling

### Manual Testing

- End-to-end deployment with SSL verification
- Certificate expiry and renewal workflows
- Proxy restart scenarios with certificate persistence
- Custom certificate upload and management

## Implementation Notes

### Debug Commands Enhancement

```bash
# Certificate-specific debugging
ssh luma@157.180.25.101 "docker exec luma-proxy luma-proxy cert status"
ssh luma@157.180.25.101 "docker exec luma-proxy luma-proxy cert list"
ssh luma@157.180.101 "docker exec luma-proxy luma-proxy cert check <domain>"
```

### Health Check Integration

The existing `/luma-proxy/health` endpoint should include:

- Certificate validity status
- Expiry dates for all managed certificates
- Last renewal attempt status
- Rate limiting status

## Priority

**High** - SSL certificate issues directly impact production availability and security posture.

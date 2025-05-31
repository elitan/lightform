# SSL Certificate Acquisition Fix - Implementation Plan

## Problem Statement

The Luma proxy is failing to acquire SSL certificates through ACME/Let's Encrypt, with the following observed issues:

1. **Certificate acquisition attempts are completely silent** - no ACME processing logs
2. **Email requirement blocking certificate acquisition** - proxy requires email but research shows it should be optional
3. **Certificate status stuck in "pending"** - no background worker processing pending certificates
4. **HTTPS timeouts** - domains return connection timeouts instead of valid certificates

**⚠️ CRITICAL: Always use Let's Encrypt staging mode for development and testing to avoid production rate limits.**

## Root Cause Analysis

### Research Findings

Based on extensive research of ACME protocol implementations and Let's Encrypt documentation:

1. **Email is officially optional** for ACME certificate acquisition
2. **Modern ACME clients support email-free operation** (certbot `--register-unsafely-without-email`, lego `--no-email`)
3. **Let's Encrypt employees confirm** that email should be optional to prevent fake email usage
4. **Go ACME libraries support certificate acquisition without explicit account registration**
5. **Staging mode is essential for testing** - Let's Encrypt provides a staging environment with much higher rate limits specifically for development and testing

### Technical Root Causes

1. **Missing Background Certificate Worker** - Certificate acquisition isn't happening because no worker processes pending certificates
2. **Overly Strict Email Validation** - Code requires email when ACME protocol doesn't mandate it
3. **Silent ACME Failures** - ACME operations fail silently without proper error logging
4. **Registration vs Acquisition Confusion** - Code conflates account registration (optional) with certificate acquisition (required)
5. **Testing in Production Mode** - Development/testing should always use staging mode to avoid rate limits

## Solution Architecture

### Core Principle: Make Email Truly Optional + Always Use Staging Mode for Testing

The fix will implement these changes:

1. **Email-Optional ACME Client** - Allow certificate acquisition without email
2. **Robust Background Workers** - Ensure certificate acquisition actually runs
3. **Comprehensive Logging** - Make ACME operations visible for debugging
4. **Graceful Degradation** - Work without email, with email if provided
5. **Staging Mode Default** - Always enable staging mode for development and testing

### Implementation Strategy

#### Phase 0: Enable Staging Mode (ESSENTIAL)

**⚠️ ALWAYS enable staging mode before any certificate testing:**

```bash
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"
```

Staging mode benefits:

- Much higher rate limits (no practical limits for testing)
- Faster certificate issuance
- Safe to experiment and debug
- Prevents accidental production rate limit hits

#### Phase 1: Make Email Optional (Core Fix)

- [ ] Modify ACME client initialization to work without email
- [ ] Update account registration to be conditional on email presence
- [ ] Test certificate acquisition without any email configuration in staging mode

#### Phase 2: Fix Background Workers (Essential)

- [ ] Ensure certificate acquisition worker actually runs
- [ ] Add proper background worker lifecycle management
- [ ] Implement proper pending certificate processing

#### Phase 3: Enhanced Logging (Debugging)

- [ ] Add comprehensive ACME operation logging
- [ ] Log certificate acquisition attempts, successes, and failures
- [ ] Add background worker status logging

#### Phase 4: Testing & Validation (Quality)

- [ ] Test certificate acquisition with and without email in staging mode
- [ ] Verify background workers process pending certificates
- [ ] Validate staging mode works correctly

## Detailed Implementation Plan

### 1. ACME Client Modifications

**File: `internal/acme/client.go` (or equivalent)**

```go
// Current (broken): Always requires email
func NewACMEClient(email string) (*ACMEClient, error) {
    if email == "" {
        return nil, errors.New("email required")
    }
    // Registration with email
}

// Fixed: Email optional
func NewACMEClient(email string) (*ACMEClient, error) {
    // Work with or without email
    if email != "" {
        // Register with email if provided
    } else {
        // Skip registration or register without email
    }
}
```

### 2. Background Worker Fixes

**File: `internal/workers/certificate.go` (or equivalent)**

```go
// Ensure workers actually start and process pending certificates
func (w *CertificateWorker) Start() {
    go w.processPendingCertificates()
    go w.renewExpiringCertificates()
}

func (w *CertificateWorker) processPendingCertificates() {
    for {
        pending := w.state.GetPendingCertificates()
        for _, cert := range pending {
            w.acquireCertificate(cert.Host)
        }
        time.Sleep(30 * time.Second)
    }
}
```

### 3. Enhanced Logging

**Add throughout ACME operations:**

```go
log.Printf("[CERT] [%s] Starting certificate acquisition", host)
log.Printf("[ACME] [%s] Creating ACME client", host)
log.Printf("[ACME] [%s] Account registration: %s", host, status)
log.Printf("[CERT] [%s] Certificate acquired successfully", host)
log.Printf("[CERT] [%s] Certificate acquisition failed: %v", host, err)
```

### 4. Configuration Changes

**Make email optional in configuration and ensure staging mode:**

```json
{
  "lets_encrypt": {
    "account_key_file": "/var/lib/luma-proxy/certs/account.key",
    "directory_url": "https://acme-staging-v02.api.letsencrypt.org/directory",
    "email": "", // Optional: empty string means no email
    "staging": true // ALWAYS true for development/testing
  }
}
```

## Testing Strategy

### Stage 0: Enable Staging Mode (MANDATORY)

```bash
# 1. ALWAYS enable staging mode first
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"

# 2. Verify staging mode is enabled
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy list" | grep -i staging
```

### Stage 1: Email-Free Certificate Acquisition

```bash
# 1. Complete server cleanup
ssh luma@157.180.25.101 "docker stop \$(docker ps -aq) && docker system prune -af --volumes"

# 2. Deploy updated proxy (no email configured)
cd proxy && ./publish.sh && cd ../examples/basic

# 3. Setup infrastructure
bun ../../src/index.ts setup --verbose

# 4. Enable staging mode (CRITICAL STEP)
ssh luma@157.180.25.101 "docker exec luma-proxy /usr/local/bin/luma-proxy set-staging --enabled true"

# 5. Deploy without email in state
bun ../../src/index.ts deploy --force --verbose

# 6. Verify certificate acquisition works in staging mode
curl -k -I https://test.eliasson.me  # Should work without email (staging cert will show warnings)
```

### Stage 2: Background Worker Verification

```bash
# Monitor logs for background worker activity (in staging mode)
ssh luma@157.180.25.101 "docker logs -f luma-proxy | grep -E 'CERT|WORKER|ACME'"

# Should see:
# [WORKER] Certificate worker started
# [CERT] [test.eliasson.me] Processing pending certificate
# [ACME] [test.eliasson.me] Starting ACME acquisition
# [CERT] [test.eliasson.me] Certificate acquired successfully
```

### Stage 3: Comprehensive Testing

```bash
# Test both with and without email in staging mode
# Test certificate renewal in staging mode
# Test staging vs production mode (only switch to production for final deployment)
# Test multiple domains in staging mode
# Test failure scenarios in staging mode
```

## Success Criteria

### Primary Goals (Must Have)

- [ ] SSL certificates acquire successfully without email configuration in staging mode
- [ ] HTTPS works immediately after deployment in staging mode (staging certificates will show browser warnings)
- [ ] Background workers visibly process pending certificates
- [ ] Certificate acquisition is logged and debuggable
- [ ] Staging mode is properly configured and working

### Secondary Goals (Should Have)

- [ ] Email configuration still works if provided
- [ ] Certificate renewal works reliably in staging mode
- [ ] Rate limiting is properly handled (should not be an issue in staging)
- [ ] Multiple domains can be acquired simultaneously in staging mode

### Quality Goals (Nice to Have)

- [ ] Comprehensive error messages for debugging
- [ ] Certificate status reporting is accurate
- [ ] Performance is optimal (fast certificate acquisition in staging mode)

## Risk Mitigation

### High Risk: Breaking Existing Functionality

- **Mitigation**: Maintain backward compatibility with email configuration
- **Testing**: Test both email and no-email scenarios thoroughly in staging mode

### Medium Risk: ACME Rate Limiting

- **Mitigation**: Always test in staging mode first (much higher rate limits)
- **Recovery**: Clear procedures for handling rate limit scenarios
- **Prevention**: Never test in production mode during development

### Low Risk: Certificate Renewal Issues

- **Mitigation**: Implement robust renewal worker with proper error handling
- **Monitoring**: Enhanced logging for all renewal operations

## Implementation Timeline

### Phase 0: Staging Mode Setup (Day 0 - MANDATORY)

- Enable staging mode immediately
- Verify staging mode is working
- Document staging mode procedures

### Phase 1: Core Fix (Day 1)

- Make email optional in ACME client
- Fix background workers
- Basic logging improvements
- Test in staging mode only

### Phase 2: Testing & Validation (Day 1-2)

- Comprehensive testing in staging mode
- Verify both email and no-email scenarios
- End-to-end SSL validation with staging certificates

### Phase 3: Documentation & Cleanup (Day 2)

- Update PDR documentation
- Update DEBUG.md with new procedures
- Code cleanup and optimization

## Dependencies

### External Dependencies

- Let's Encrypt staging environment (for testing) - always use this for development
- DNS configuration (test.eliasson.me points to server)
- Server access (SSH to 157.180.25.101)

### Internal Dependencies

- Proxy codebase understanding (Go implementation)
- Docker build/publish pipeline (./publish.sh)
- CLI integration (deployment commands)

## Rollback Plan

If the implementation causes issues:

1. **Immediate Rollback**: Revert to previous proxy image
2. **State Recovery**: Restore proxy state from backup
3. **Emergency Email Config**: Temporarily add email to state.json
4. **Debug Mode**: Enable verbose logging to identify issues
5. **Staging Mode**: Ensure staging mode is always enabled during debugging

## Definition of Done

This fix is complete when:

1. ✅ SSL certificates acquire successfully without email in staging mode
2. ✅ Background workers are visibly processing certificates (logs show activity)
3. ✅ HTTPS responses work immediately after deployment (staging certificates)
4. ✅ Certificate acquisition process is fully debuggable via logs
5. ✅ Both email and no-email configurations are supported
6. ✅ Staging mode works reliably for testing and development
7. ✅ Production mode is only used for final deployments

## Next Steps

1. **Review this plan** with the team
2. **IMMEDIATELY enable staging mode** for all testing
3. **Examine proxy codebase** to identify specific files to modify
4. **Implement Phase 1** changes (email-optional ACME client)
5. **Test immediately** with staging mode only
6. **Iterate rapidly** based on test results

---

**Note**: This plan prioritizes getting SSL certificates working reliably in staging mode first, then optimizing for production use. The key insights from our research are:

1. Email should be optional
2. Staging mode should always be used for development/testing
3. Making these changes will likely resolve the certificate acquisition issues we're experiencing.

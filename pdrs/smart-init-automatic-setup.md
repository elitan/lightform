# Smart Init: Automatic Server Setup & Bootstrap

**Date:** 2024-12-19  
**Status:** Draft  
**Owner:** Luma Team  
**Priority:** High

## 🎯 Executive Summary

Transform the `luma init` command into a super-intelligent setup orchestrator that automates the entire server preparation process. Provide a Vercel-like developer experience where users can go from zero to deployed with a single command. All server setup logic will be implemented in TypeScript modules within the init command - no external shell scripts.

## 🔥 Problem Statement

### Current Pain Points

1. **Manual server setup** requires 6+ manual steps and technical expertise
2. **High barrier to entry** - users need to understand Docker, SSH, security hardening
3. **Error-prone process** - easy to miss steps or misconfigure security
4. **Time consuming** - takes 15-30 minutes to prepare a server
5. **Documentation heavy** - requires reading long setup guides

### Impact

- **User drop-off** during onboarding
- **Support burden** from setup issues
- **Competitive disadvantage** vs. PaaS solutions
- **Slower time-to-value** for new users

## 🚀 Solution Overview

Create a super-intelligent `luma init` command that:

- **Automatically detects** server setup requirements
- **Orchestrates** all setup tasks via TypeScript modules
- **Provides** real-time progress feedback
- **Handles** errors gracefully with recovery
- **Validates** complete end-to-end functionality

### Core Philosophy

- **Single Command**: `luma init` does everything
- **TypeScript First**: All logic in TypeScript modules, no shell scripts
- **Intelligent**: Auto-detect needs and optimize for each server
- **Resilient**: Handle failures and provide clear recovery paths
- **Modular**: Clean separation of concerns within init.ts

## 📋 Requirements

### Functional Requirements

#### FR-1: Intelligent Server Detection

- **FR-1.1** Auto-detect server OS and architecture during init
- **FR-1.2** Test SSH connectivity and permissions
- **FR-1.3** Identify missing components (Docker, users, dependencies)
- **FR-1.4** Assess server resources and capabilities
- **FR-1.5** Generate setup recommendations

#### FR-2: Automated Setup Orchestration

- **FR-2.1** Install Docker via package manager commands
- **FR-2.2** Create dedicated `luma` user with proper permissions
- **FR-2.3** Configure SSH security (disable password auth, setup fail2ban)
- **FR-2.4** Install required system dependencies
- **FR-2.5** Validate all installations and configurations

#### FR-3: Smart Init Experience

- **FR-3.1** `luma init` handles project config AND server setup
- **FR-3.2** Present clear setup plan before execution
- **FR-3.3** Execute setup with real-time progress feedback
- **FR-3.4** Validate end-to-end functionality
- **FR-3.5** Provide immediate deploy readiness

#### FR-4: Error Handling & Recovery

- **FR-4.1** Graceful handling of network failures
- **FR-4.2** Automatic retry with exponential backoff
- **FR-4.3** Clear error messages with actionable solutions
- **FR-4.4** Partial failure recovery
- **FR-4.5** Dry-run mode for testing

### Non-Functional Requirements

#### NFR-1: Security

- **NFR-1.1** Minimal privilege escalation
- **NFR-1.2** Security hardening by default
- **NFR-1.3** Audit logging of all setup actions
- **NFR-1.4** Secure command execution over SSH

#### NFR-2: Reliability

- **NFR-2.1** Idempotent operations (safe to run multiple times)
- **NFR-2.2** Atomic operations where possible
- **NFR-2.3** Comprehensive error handling
- **NFR-2.4** 99.9% success rate for supported OS versions

#### NFR-3: Performance

- **NFR-3.1** Complete server setup in <5 minutes
- **NFR-3.2** Parallel setup for multiple servers
- **NFR-3.3** Minimal resource usage during setup
- **NFR-3.4** Efficient command execution

#### NFR-4: Usability

- **NFR-4.1** Clear, actionable error messages
- **NFR-4.2** Progress indicators with time estimates
- **NFR-4.3** Consistent experience across platforms
- **NFR-4.4** Self-documenting commands and output

## 🎨 User Experience

### Target User Journey

```
1. User runs: luma init
2. Configure project (existing flow)
3. Auto-detect servers and setup needs
4. Present setup plan: "Setup 2 servers automatically? (Y/n)"
5. Execute with real-time progress
6. Validate end-to-end functionality
7. Ready to deploy immediately
```

### Example CLI Flow

```bash
❯ luma init
✓ Created luma.yml configuration

🔍 Analyzing servers...
✓ SSH connection to server1.example.com (Ubuntu 22.04)
✓ SSH connection to server2.example.com (Ubuntu 20.04)

📋 Setup Plan:
  server1.example.com: Install Docker, create luma user, configure SSH
  server2.example.com: Install Docker, create luma user, configure SSH

🚀 Setup servers automatically? (Y/n): Y

📦 Setting up servers...
  server1.example.com:
    ✓ Installing Docker (2.3s)
    ✓ Creating luma user (0.8s)
    ✓ Configuring SSH security (1.2s)
    ✓ Installing dependencies (3.1s)
    ✓ Validating setup (0.5s)

  server2.example.com:
    ✓ Installing Docker (2.1s)
    ✓ Creating luma user (0.7s)
    ✓ Configuring SSH security (1.1s)
    ✓ Installing dependencies (2.9s)
    ✓ Validating setup (0.4s)

🎉 All servers ready! Run 'luma deploy' to ship your app.
```

## 🏗 Technical Implementation

### Architecture Overview

All server setup logic will be implemented as TypeScript modules within the `init.ts` command file, organized into clean, testable functions.

### Module Structure

```typescript
// src/commands/init.ts
import { ServerDetector } from "../lib/server-detector";
import { DockerInstaller } from "../lib/docker-installer";
import { UserManager } from "../lib/user-manager";
import { SecurityHardener } from "../lib/security-hardener";
import { SystemValidator } from "../lib/system-validator";
import { SetupOrchestrator } from "../lib/setup-orchestrator";
```

### Core Modules

#### 1. Server Detector (`src/lib/server-detector.ts`)

- **OS Detection** - identify Ubuntu/Debian version and architecture
- **SSH Testing** - verify connectivity and permissions
- **Capability Assessment** - check existing installations
- **Resource Analysis** - CPU, memory, disk space
- **Network Validation** - connectivity and port availability

#### 2. Docker Installer (`src/lib/docker-installer.ts`)

- **Installation Detection** - check if Docker already exists
- **Repository Setup** - configure Docker CE repository
- **Package Installation** - install Docker via apt/apt-get
- **Daemon Configuration** - optimize Docker settings
- **Service Management** - start and enable Docker service
- **Permission Setup** - add users to docker group

#### 3. User Manager (`src/lib/user-manager.ts`)

- **User Creation** - create `luma` user with proper home directory
- **Group Assignment** - add to docker, sudo groups
- **Sudoers Configuration** - setup passwordless sudo
- **SSH Directory** - configure .ssh structure and permissions
- **Key Management** - handle SSH key setup

#### 4. Security Hardener (`src/lib/security-hardener.ts`)

- **SSH Configuration** - disable password auth, configure settings
- **Fail2ban Setup** - install and configure fail2ban
- **System Updates** - configure automatic security updates
- **Permission Hardening** - secure file and directory permissions

#### 5. System Validator (`src/lib/system-validator.ts`)

- **Docker Validation** - test daemon status and functionality
- **User Validation** - verify permissions and sudo access
- **SSH Validation** - test configuration and connectivity
- **Service Validation** - check all services are running
- **End-to-End Testing** - validate complete setup

#### 6. Setup Orchestrator (`src/lib/setup-orchestrator.ts`)

- **Multi-Server Coordination** - manage parallel setup operations
- **Progress Tracking** - real-time status updates and timing
- **Error Recovery** - handle failures and retry logic
- **State Management** - track setup progress across servers
- **Rollback Management** - cleanup on failures

## 📊 Implementation Checklist

### Phase 1: Core Infrastructure (Week 1-2)

#### 1.1 Server Detection Module

- [ ] **Create ServerDetector class** (`src/lib/server-detector.ts`)

  - [ ] SSH connection testing with timeout handling
  - [ ] OS detection via `/etc/os-release` parsing
  - [ ] Architecture detection (`uname -m`)
  - [ ] System resource checking (CPU, RAM, disk)
  - [ ] Existing service detection (Docker, users)

- [ ] **Network connectivity testing**

  - [ ] Basic internet connectivity check
  - [ ] Package repository accessibility
  - [ ] DNS resolution testing
  - [ ] Port availability checking

- [ ] **Capability profiling**
  - [ ] Package manager detection (apt/apt-get)
  - [ ] Sudo access verification
  - [ ] Systemd service management check
  - [ ] Docker group existence check

#### 1.2 Docker Installation Module

- [ ] **Create DockerInstaller class** (`src/lib/docker-installer.ts`)

  - [ ] Detect existing Docker installation
  - [ ] Remove old Docker versions if present
  - [ ] Add Docker GPG key and repository
  - [ ] Install Docker CE packages
  - [ ] Configure Docker daemon settings

- [ ] **Service management**

  - [ ] Start Docker daemon
  - [ ] Enable Docker service for auto-start
  - [ ] Test Docker functionality with `docker run hello-world`
  - [ ] Add users to docker group
  - [ ] Verify group membership takes effect

- [ ] **Error handling**
  - [ ] Package installation failures
  - [ ] Repository access issues
  - [ ] Service startup problems
  - [ ] Permission configuration errors

#### 1.3 User Management Module

- [ ] **Create UserManager class** (`src/lib/user-manager.ts`)

  - [ ] Check if `luma` user already exists
  - [ ] Create user with proper home directory
  - [ ] Set up user groups (docker, sudo)
  - [ ] Configure sudoers for passwordless sudo
  - [ ] Create and secure .ssh directory

- [ ] **SSH key management**

  - [ ] Copy authorized_keys from root if needed
  - [ ] Set proper file permissions (600, 700)
  - [ ] Test SSH access with new user
  - [ ] Validate sudo permissions

- [ ] **User validation**
  - [ ] Test user can run Docker commands
  - [ ] Verify sudo access works
  - [ ] Check SSH connectivity
  - [ ] Validate group memberships

#### 1.4 Security Hardening Module

- [ ] **Create SecurityHardener class** (`src/lib/security-hardener.ts`)

  - [ ] Configure SSH daemon settings
  - [ ] Disable password authentication
  - [ ] Set up SSH key-only access
  - [ ] Configure connection limits and timeouts

- [ ] **Fail2ban configuration**

  - [ ] Install fail2ban package
  - [ ] Configure SSH protection rules
  - [ ] Set ban times and retry limits
  - [ ] Test fail2ban functionality

- [ ] **System security**
  - [ ] Configure automatic security updates
  - [ ] Set secure file permissions
  - [ ] Disable unnecessary services
  - [ ] Configure system logging

### Phase 2: Integration & Orchestration (Week 2)

#### 2.1 System Validation Module

- [ ] **Create SystemValidator class** (`src/lib/system-validator.ts`)

  - [ ] Docker daemon health checks
  - [ ] User permission validation
  - [ ] SSH configuration testing
  - [ ] Service status verification
  - [ ] Network connectivity validation

- [ ] **End-to-end testing**

  - [ ] Deploy test container
  - [ ] Test container networking
  - [ ] Validate user permissions
  - [ ] Check security configurations
  - [ ] Performance baseline testing

- [ ] **Health monitoring**
  - [ ] System resource monitoring
  - [ ] Service uptime tracking
  - [ ] Error rate monitoring
  - [ ] Performance metrics collection

#### 2.2 Setup Orchestrator Module

- [ ] **Create SetupOrchestrator class** (`src/lib/setup-orchestrator.ts`)

  - [ ] Server setup state management
  - [ ] Parallel execution coordination
  - [ ] Progress tracking and reporting
  - [ ] Error aggregation and handling
  - [ ] Rollback coordination

- [ ] **Execution management**

  - [ ] Task dependency resolution
  - [ ] Parallel vs sequential execution
  - [ ] Timeout management
  - [ ] Resource coordination
  - [ ] State persistence

- [ ] **Error handling**
  - [ ] Partial failure management
  - [ ] Retry logic with backoff
  - [ ] Rollback on critical failures
  - [ ] Error reporting and logging

#### 2.3 Enhanced Init Command

- [ ] **Update init command** (`src/commands/init.ts`)

  - [ ] Integrate all setup modules
  - [ ] Add server detection and analysis
  - [ ] Implement setup planning and confirmation
  - [ ] Add progress indicators and feedback
  - [ ] Integrate validation and testing

- [ ] **User experience flow**

  - [ ] Project configuration (existing)
  - [ ] Server discovery and analysis
  - [ ] Setup plan presentation
  - [ ] User confirmation prompt
  - [ ] Execution with progress tracking
  - [ ] Validation and success confirmation

- [ ] **Command options**
  - [ ] `--dry-run` flag for testing
  - [ ] `--force` flag for re-setup
  - [ ] `--verbose` flag for detailed output
  - [ ] `--skip-validation` for speed
  - [ ] `--parallel` for multi-server setup

### Phase 3: Polish & Optimization (Week 3-4)

#### 3.1 Error Handling & Recovery

## 🎯 Success Criteria

- [ ] **Single Command Setup**: `luma init` handles complete server preparation
- [ ] **High Success Rate**: 99%+ success rate on supported OS versions
- [ ] **Fast Execution**: Complete setup in <5 minutes per server
- [ ] **Intelligent Detection**: Auto-detect and handle all common scenarios
- [ ] **Clear Feedback**: Real-time progress with time estimates
- [ ] **Robust Error Handling**: Graceful failure handling with recovery
- [ ] **Security First**: Apply security hardening by default
- [ ] **Zero External Dependencies**: All logic in TypeScript, no shell scripts

## 🚨 Risks & Mitigations

### High Risk

- **SSH execution security** in TypeScript modules
  - _Mitigation_: Use established SSH libraries, input sanitization, privilege minimization
- **OS compatibility** across Linux distributions
  - _Mitigation_: Comprehensive testing matrix, graceful degradation

## 📝 Notes

- **TypeScript First**: All logic implemented in TypeScript modules, no external shell scripts
- **Modular Design**: Clean separation allows for easy testing and maintenance
- **Security Focus**: Security hardening applied by default, minimal privilege escalation
- **User Experience**: Single command that handles everything with clear feedback
- **Extensibility**: Modular design allows for easy addition of new capabilities

---

_This document replaces both the original PRD and TODO, consolidating everything into a single comprehensive plan focused on the smart init command approach._

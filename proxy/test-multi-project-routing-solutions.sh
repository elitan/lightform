#!/bin/bash

# Comprehensive Multi-Project Routing Solutions Test
# Tests different approaches to solve the network isolation problem

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}🧪 Testing Multi-Project Routing Solutions${NC}"
echo "=================================================="

# Function to log test steps
log_step() {
    echo -e "${BLUE}➤ $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

# Cleanup function
cleanup() {
    log_step "Cleaning up test environment..."
    
    # Stop and remove test containers
    docker rm -f \
        test-proxy-main \
        project-a-web-1 project-a-web-2 \
        project-b-web-1 project-b-web-2 \
        helper-project-a helper-project-b \
        2>/dev/null || true
    
    # Remove test networks
    docker network rm \
        project-a-network project-b-network \
        proxy-main-network \
        2>/dev/null || true
    
    log_success "Cleanup completed"
}

# Trap to ensure cleanup on exit
trap cleanup EXIT

# Step 1: Create Test Environment
log_step "Creating multi-project test environment..."

# Create networks
docker network create project-a-network
docker network create project-b-network  
docker network create proxy-main-network

# Create Project A containers (both with alias 'web')
docker run -d --name project-a-web-1 \
    --network project-a-network \
    --network-alias web \
    nginx:alpine \
    sh -c 'echo "server { listen 3000; location / { return 200 \"Project A - Container 1 - Response\"; add_header Content-Type text/plain; } }" > /etc/nginx/conf.d/default.conf && nginx -g "daemon off;"'

docker run -d --name project-a-web-2 \
    --network project-a-network \
    --network-alias web \
    nginx:alpine \
    sh -c 'echo "server { listen 3000; location / { return 200 \"Project A - Container 2 - Response\"; add_header Content-Type text/plain; } }" > /etc/nginx/conf.d/default.conf && nginx -g "daemon off;"'

# Create Project B containers (both with alias 'web')
docker run -d --name project-b-web-1 \
    --network project-b-network \
    --network-alias web \
    nginx:alpine \
    sh -c 'echo "server { listen 3000; location / { return 200 \"Project B - Container 1 - Response\"; add_header Content-Type text/plain; } }" > /etc/nginx/conf.d/default.conf && nginx -g "daemon off;"'

docker run -d --name project-b-web-2 \
    --network project-b-network \
    --network-alias web \
    nginx:alpine \
    sh -c 'echo "server { listen 3000; location / { return 200 \"Project B - Container 2 - Response\"; add_header Content-Type text/plain; } }" > /etc/nginx/conf.d/default.conf && nginx -g "daemon off;"'

# Create main proxy container connected to ALL networks (the problematic scenario)
docker run -d --name test-proxy-main \
    --network proxy-main-network \
    alpine:latest \
    sh -c 'apk add --no-cache curl && sleep 36000'

# Connect proxy to both project networks (this causes the DNS collision issue)
docker network connect project-a-network test-proxy-main
docker network connect project-b-network test-proxy-main

log_success "Test environment created"

# Wait for services to be ready
sleep 3

echo
echo "=================================================="
log_step "TESTING THE PROBLEM: DNS Collision Issue"
echo "=================================================="

# Test 1: Demonstrate the DNS collision problem
log_step "Test 1: DNS Collision - What does 'web:3000' resolve to?"

# Make multiple requests to see which project gets hit
RESULTS=()
for i in {1..10}; do
    RESULT=$(docker exec test-proxy-main curl -s --connect-timeout 3 http://web:3000 2>/dev/null || echo "FAILED")
    RESULTS+=("$RESULT")
done

# Analyze results
PROJECT_A_COUNT=0
PROJECT_B_COUNT=0
for result in "${RESULTS[@]}"; do
    if [[ "$result" == *"Project A"* ]]; then
        ((PROJECT_A_COUNT++))
    elif [[ "$result" == *"Project B"* ]]; then
        ((PROJECT_B_COUNT++))
    fi
done

echo "Results from 10 requests to 'web:3000':"
echo "  Project A responses: $PROJECT_A_COUNT"
echo "  Project B responses: $PROJECT_B_COUNT"

if [[ $PROJECT_A_COUNT -gt 0 && $PROJECT_B_COUNT -eq 0 ]]; then
    log_error "DNS collision confirmed: All requests go to Project A (Project B unreachable)"
    COLLISION_WINNER="Project A"
elif [[ $PROJECT_B_COUNT -gt 0 && $PROJECT_A_COUNT -eq 0 ]]; then
    log_error "DNS collision confirmed: All requests go to Project B (Project A unreachable)"
    COLLISION_WINNER="Project B"
else
    log_warning "Unexpected result: Mixed responses or failures"
    COLLISION_WINNER="Mixed"
fi

echo
echo "=================================================="
log_step "SOLUTION TESTING: Different Isolation Approaches"
echo "=================================================="

# Solution 1: Project-Specific Helper Containers
log_step "Solution 1: Project-Specific Helper Containers"

# Create helpers connected to only ONE network each
docker run -d --name helper-project-a \
    --network project-a-network \
    alpine:latest \
    sh -c 'apk add --no-cache curl && sleep 36000'

docker run -d --name helper-project-b \
    --network project-b-network \
    alpine:latest \
    sh -c 'apk add --no-cache curl && sleep 36000'

sleep 2

# Test isolated access
PROJECT_A_RESPONSE=$(docker exec helper-project-a curl -s --connect-timeout 3 http://web:3000 2>/dev/null || echo "FAILED")
PROJECT_B_RESPONSE=$(docker exec helper-project-b curl -s --connect-timeout 3 http://web:3000 2>/dev/null || echo "FAILED")

echo "Project A helper -> web:3000: $PROJECT_A_RESPONSE"
echo "Project B helper -> web:3000: $PROJECT_B_RESPONSE"

if [[ "$PROJECT_A_RESPONSE" == *"Project A"* && "$PROJECT_B_RESPONSE" == *"Project B"* ]]; then
    log_success "Solution 1 WORKS: Project-specific helpers provide proper isolation"
    SOLUTION_1_WORKS=true
else
    log_error "Solution 1 FAILED: Helpers don't provide proper isolation"
    SOLUTION_1_WORKS=false
fi

# Solution 2: IP-Based Routing
log_step "Solution 2: IP-Based Routing"

# Get IPs of containers in each network
PROJECT_A_IP1=$(docker inspect project-a-web-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' | head -1)
PROJECT_A_IP2=$(docker inspect project-a-web-2 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' | head -1)
PROJECT_B_IP1=$(docker inspect project-b-web-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' | head -1)
PROJECT_B_IP2=$(docker inspect project-b-web-2 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' | head -1)

echo "Container IPs:"
echo "  Project A: $PROJECT_A_IP1, $PROJECT_A_IP2"
echo "  Project B: $PROJECT_B_IP1, $PROJECT_B_IP2"

# Test IP-based access from main proxy
IP_A_RESPONSE=$(docker exec test-proxy-main curl -s --connect-timeout 3 http://$PROJECT_A_IP1:3000 2>/dev/null || echo "FAILED")
IP_B_RESPONSE=$(docker exec test-proxy-main curl -s --connect-timeout 3 http://$PROJECT_B_IP1:3000 2>/dev/null || echo "FAILED")

echo "Proxy -> Project A IP: $IP_A_RESPONSE"
echo "Proxy -> Project B IP: $IP_B_RESPONSE"

if [[ "$IP_A_RESPONSE" == *"Project A"* && "$IP_B_RESPONSE" == *"Project B"* ]]; then
    log_success "Solution 2 WORKS: IP-based routing provides proper isolation"
    SOLUTION_2_WORKS=true
else
    log_error "Solution 2 FAILED: IP-based routing doesn't work"
    SOLUTION_2_WORKS=false
fi

# Solution 3: Project-Specific Aliases
log_step "Solution 3: Project-Specific Network Aliases"

# Add project-specific aliases to existing containers by disconnecting and reconnecting
docker network disconnect project-a-network project-a-web-1 || true
docker network disconnect project-b-network project-b-web-1 || true

docker network connect project-a-network project-a-web-1 --alias project-a-web --alias web
docker network connect project-b-network project-b-web-1 --alias project-b-web --alias web

sleep 1

# Test project-specific aliases from main proxy
ALIAS_A_RESPONSE=$(docker exec test-proxy-main curl -s --connect-timeout 3 http://project-a-web:3000 2>/dev/null || echo "FAILED")
ALIAS_B_RESPONSE=$(docker exec test-proxy-main curl -s --connect-timeout 3 http://project-b-web:3000 2>/dev/null || echo "FAILED")

echo "Proxy -> project-a-web:3000: $ALIAS_A_RESPONSE"
echo "Proxy -> project-b-web:3000: $ALIAS_B_RESPONSE"

if [[ "$ALIAS_A_RESPONSE" == *"Project A"* && "$ALIAS_B_RESPONSE" == *"Project B"* ]]; then
    log_success "Solution 3 WORKS: Project-specific aliases provide proper isolation"
    SOLUTION_3_WORKS=true
else
    log_error "Solution 3 FAILED: Project-specific aliases don't work"
    SOLUTION_3_WORKS=false
fi

echo
echo "=================================================="
log_step "SOLUTION ANALYSIS & RECOMMENDATIONS"
echo "=================================================="

echo "Problem Summary:"
echo "  • Multi-network proxy causes DNS collisions"
echo "  • 'web:3000' resolves ambiguously when connected to multiple networks"
echo "  • DNS winner: $COLLISION_WINNER (other projects become unreachable)"
echo

echo "Solution Test Results:"
if [[ $SOLUTION_1_WORKS == true ]]; then
    log_success "✅ Solution 1: Project-Specific Helpers - RECOMMENDED"
    echo "     • Each project gets its own helper container"
    echo "     • Helpers connected to only ONE network each"
    echo "     • DNS resolution works correctly within network scope"
    echo "     • Proxy delegates to appropriate helper based on project"
else
    log_error "❌ Solution 1: Project-Specific Helpers - FAILED"
fi

if [[ $SOLUTION_2_WORKS == true ]]; then
    log_success "✅ Solution 2: IP-Based Routing - VIABLE"
    echo "     • Use container IPs instead of DNS names"
    echo "     • Requires IP resolution and tracking"
    echo "     • More complex but avoids DNS collisions"
    echo "     • May have issues with container restarts"
else
    log_error "❌ Solution 2: IP-Based Routing - FAILED"
fi

if [[ $SOLUTION_3_WORKS == true ]]; then
    log_success "✅ Solution 3: Project-Specific Aliases - SIMPLE"
    echo "     • Use 'project-name-web:3000' instead of 'web:3000'"
    echo "     • Requires changing deployment aliases"
    echo "     • Simple but breaks existing conventions"
    echo "     • Single proxy can route to all projects correctly"
else
    log_error "❌ Solution 3: Project-Specific Aliases - FAILED"
fi

echo
echo "=================================================="
log_step "RECOMMENDED IMPLEMENTATION STRATEGY"
echo "=================================================="

echo "For Luma Proxy Implementation:"
echo
log_success "PRIMARY RECOMMENDATION: Hybrid Approach"
echo "  1. Use project-specific aliases during deployment:"
echo "     • Deploy as '{project}-web:3000' instead of 'web:3000'"
echo "     • Proxy routes based on Host header -> project-specific alias"
echo "     • Example: test.eliasson.me -> gmail-web:3000"
echo "     • Example: nextjs.example.com -> nextjs-web:3000"
echo
echo "  2. Keep helper containers as backup for health checks:"
echo "     • If project-specific routing fails, use helpers"
echo "     • Helpers provide guaranteed network isolation"
echo
echo "  3. Implementation changes needed:"
echo "     • Modify deployment to use {project}-{app}:{port} aliases"
echo "     • Update proxy routing logic to resolve project-specific names"
echo "     • Keep existing 'web' alias for backward compatibility"

echo
log_step "Test completed! 🚀" 
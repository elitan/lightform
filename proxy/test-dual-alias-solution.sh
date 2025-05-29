#!/bin/bash

# Test Dual Network Alias Solution
# Each container gets both 'web' and '{project}-web' aliases

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}🧪 Testing Dual Network Alias Solution${NC}"
echo "=============================================="

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

# Cleanup function
cleanup() {
    log_step "Cleaning up test environment..."
    
    docker rm -f \
        test-proxy-dual \
        gmail-web-1 gmail-web-2 \
        nextjs-web-1 nextjs-web-2 \
        2>/dev/null || true
    
    docker network rm \
        gmail-network nextjs-network \
        proxy-dual-network \
        2>/dev/null || true
    
    log_success "Cleanup completed"
}

# Trap to ensure cleanup on exit
trap cleanup EXIT

# Step 1: Create Test Environment with Dual Aliases
log_step "Creating test environment with dual aliases..."

# Create networks
docker network create gmail-network
docker network create nextjs-network  
docker network create proxy-dual-network

# Create Gmail containers with DUAL aliases
docker run -d --name gmail-web-1 \
    --network gmail-network \
    --network-alias web \
    --network-alias gmail-web \
    nginx:alpine \
    sh -c 'echo "server { listen 3000; location / { return 200 \"Gmail Project - Container 1\"; add_header Content-Type text/plain; } }" > /etc/nginx/conf.d/default.conf && sed -i "/listen.*80/d" /etc/nginx/nginx.conf && nginx -g "daemon off;"'

docker run -d --name gmail-web-2 \
    --network gmail-network \
    --network-alias web \
    --network-alias gmail-web \
    nginx:alpine \
    sh -c 'echo "server { listen 3000; location / { return 200 \"Gmail Project - Container 2\"; add_header Content-Type text/plain; } }" > /etc/nginx/conf.d/default.conf && sed -i "/listen.*80/d" /etc/nginx/nginx.conf && nginx -g "daemon off;"'

# Create Next.js containers with DUAL aliases
docker run -d --name nextjs-web-1 \
    --network nextjs-network \
    --network-alias web \
    --network-alias nextjs-web \
    nginx:alpine \
    sh -c 'echo "server { listen 3000; location / { return 200 \"Next.js Project - Container 1\"; add_header Content-Type text/plain; } }" > /etc/nginx/conf.d/default.conf && sed -i "/listen.*80/d" /etc/nginx/nginx.conf && nginx -g "daemon off;"'

docker run -d --name nextjs-web-2 \
    --network nextjs-network \
    --network-alias web \
    --network-alias nextjs-web \
    nginx:alpine \
    sh -c 'echo "server { listen 3000; location / { return 200 \"Next.js Project - Container 2\"; add_header Content-Type text/plain; } }" > /etc/nginx/conf.d/default.conf && sed -i "/listen.*80/d" /etc/nginx/nginx.conf && nginx -g "daemon off;"'

# Create proxy container connected to ALL networks
docker run -d --name test-proxy-dual \
    --network proxy-dual-network \
    alpine:latest \
    sh -c 'apk add --no-cache curl && sleep 36000'

# Connect proxy to both project networks
docker network connect gmail-network test-proxy-dual
docker network connect nextjs-network test-proxy-dual

log_success "Test environment created with dual aliases"

# Wait for services to be ready
sleep 3

echo
echo "=============================================="
log_step "TESTING DUAL ALIAS SOLUTION"
echo "=============================================="

# Test 1: Project-Specific Alias Routing (What proxy will use)
log_step "Test 1: Project-Specific Routing (Proxy Perspective)"

GMAIL_RESPONSES=()
NEXTJS_RESPONSES=()

# Test gmail-web routing
for i in {1..5}; do
    RESULT=$(docker exec test-proxy-dual curl -s --connect-timeout 3 http://gmail-web:3000 2>/dev/null || echo "FAILED")
    GMAIL_RESPONSES+=("$RESULT")
done

# Test nextjs-web routing  
for i in {1..5}; do
    RESULT=$(docker exec test-proxy-dual curl -s --connect-timeout 3 http://nextjs-web:3000 2>/dev/null || echo "FAILED")
    NEXTJS_RESPONSES+=("$RESULT")
done

# Analyze gmail results
GMAIL_SUCCESS=true
for result in "${GMAIL_RESPONSES[@]}"; do
    if [[ "$result" != *"Gmail Project"* ]]; then
        GMAIL_SUCCESS=false
        break
    fi
done

# Analyze nextjs results
NEXTJS_SUCCESS=true
for result in "${NEXTJS_RESPONSES[@]}"; do
    if [[ "$result" != *"Next.js Project"* ]]; then
        NEXTJS_SUCCESS=false
        break
    fi
done

echo "Project-specific routing results:"
echo "  gmail-web:3000 → $(echo "${GMAIL_RESPONSES[0]}" | cut -c1-30)..."
echo "  nextjs-web:3000 → $(echo "${NEXTJS_RESPONSES[0]}" | cut -c1-30)..."

if [[ $GMAIL_SUCCESS == true && $NEXTJS_SUCCESS == true ]]; then
    log_success "✅ Project-specific routing works perfectly!"
    ROUTING_SUCCESS=true
else
    log_error "❌ Project-specific routing failed!"
    ROUTING_SUCCESS=false
fi

# Test 2: Internal Project Communication (Generic 'web' alias)
log_step "Test 2: Internal Communication Test (Generic 'web' alias)"

# Create temporary containers within each project network to test internal communication
docker run --rm --name gmail-client \
    --network gmail-network \
    alpine:latest \
    sh -c 'apk add --no-cache curl && curl -s http://web:3000' > /tmp/gmail_internal_result 2>/dev/null &

docker run --rm --name nextjs-client \
    --network nextjs-network \
    alpine:latest \
    sh -c 'apk add --no-cache curl && curl -s http://web:3000' > /tmp/nextjs_internal_result 2>/dev/null &

# Wait for internal tests to complete
wait

GMAIL_INTERNAL=$(cat /tmp/gmail_internal_result 2>/dev/null || echo "FAILED")
NEXTJS_INTERNAL=$(cat /tmp/nextjs_internal_result 2>/dev/null || echo "FAILED")

echo "Internal communication results:"
echo "  gmail-network: web:3000 → $(echo "$GMAIL_INTERNAL" | cut -c1-30)..."
echo "  nextjs-network: web:3000 → $(echo "$NEXTJS_INTERNAL" | cut -c1-30)..."

if [[ "$GMAIL_INTERNAL" == *"Gmail Project"* && "$NEXTJS_INTERNAL" == *"Next.js Project"* ]]; then
    log_success "✅ Internal communication works correctly in both projects!"
    INTERNAL_SUCCESS=true
else
    log_error "❌ Internal communication failed!"
    INTERNAL_SUCCESS=false
fi

# Test 3: Load Balancing Test
log_step "Test 3: Load Balancing Test (Multiple containers per alias)"

# Test gmail-web load balancing
GMAIL_CONTAINER_1_COUNT=0
GMAIL_CONTAINER_2_COUNT=0

for i in {1..20}; do
    RESULT=$(docker exec test-proxy-dual curl -s --connect-timeout 3 http://gmail-web:3000 2>/dev/null || echo "FAILED")
    if [[ "$RESULT" == *"Container 1"* ]]; then
        ((GMAIL_CONTAINER_1_COUNT++))
    elif [[ "$RESULT" == *"Container 2"* ]]; then
        ((GMAIL_CONTAINER_2_COUNT++))
    fi
done

echo "Gmail load balancing (20 requests to gmail-web:3000):"
echo "  Container 1: $GMAIL_CONTAINER_1_COUNT requests"
echo "  Container 2: $GMAIL_CONTAINER_2_COUNT requests"

if [[ $GMAIL_CONTAINER_1_COUNT -gt 0 && $GMAIL_CONTAINER_2_COUNT -gt 0 ]]; then
    log_success "✅ Load balancing works for gmail-web!"
    LOAD_BALANCE_SUCCESS=true
else
    log_error "❌ Load balancing failed for gmail-web!"
    LOAD_BALANCE_SUCCESS=false
fi

# Clean up temp files
rm -f /tmp/gmail_internal_result /tmp/nextjs_internal_result

echo
echo "=============================================="
log_step "SOLUTION SUMMARY"
echo "=============================================="

echo "Dual Alias Configuration:"
echo "  • Each container: --network-alias web --network-alias {project}-web"
echo "  • Proxy routing: Uses {project}-web (gmail-web:3000, nextjs-web:3000)"
echo "  • Internal communication: Uses web:3000 within each project"
echo

echo "Test Results:"
if [[ $ROUTING_SUCCESS == true ]]; then
    log_success "✅ Project-Specific Routing: PERFECT"
    echo "     • gmail-web:3000 → Only Gmail containers"
    echo "     • nextjs-web:3000 → Only Next.js containers"
    echo "     • Zero cross-project interference"
else
    log_error "❌ Project-Specific Routing: FAILED"
fi

if [[ $INTERNAL_SUCCESS == true ]]; then
    log_success "✅ Internal Communication: PERFECT"  
    echo "     • web:3000 resolves correctly within each project network"
    echo "     • No changes needed to existing internal code"
    echo "     • Full backward compatibility maintained"
else
    log_error "❌ Internal Communication: FAILED"
fi

if [[ $LOAD_BALANCE_SUCCESS == true ]]; then
    log_success "✅ Load Balancing: PERFECT"
    echo "     • Multiple containers with same alias load balance correctly"
    echo "     • Docker's built-in load balancing works"
else
    log_error "❌ Load Balancing: FAILED"
fi

echo
if [[ $ROUTING_SUCCESS == true && $INTERNAL_SUCCESS == true && $LOAD_BALANCE_SUCCESS == true ]]; then
    log_success "🎉 DUAL ALIAS SOLUTION: COMPLETE SUCCESS!"
    echo
    echo "RECOMMENDED IMPLEMENTATION:"
    echo "  1. Deploy containers with both aliases:"
    echo "     docker run --network-alias web --network-alias {project}-web ..."
    echo "  2. Proxy routes using project-specific aliases:"
    echo "     gmail-web:3000, nextjs-web:3000"
    echo "  3. Internal code continues using 'web:3000' within projects"
    echo "  4. Perfect isolation + backward compatibility"
else
    log_error "❌ Some tests failed - solution needs refinement"
fi

log_step "Test completed! 🚀" 
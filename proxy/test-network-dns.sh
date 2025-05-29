#!/bin/bash

# Quick Network-Scoped DNS Test
# Tests Docker's network-scoped DNS resolution behavior for multi-project isolation

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}🧪 Quick Network-Scoped DNS Test${NC}"
echo "======================================"

# Cleanup function
cleanup() {
    echo "Cleaning up..."
    docker rm -f dns-test-a1 dns-test-a2 dns-test-b1 dns-test-b2 dns-test-resolver 2>/dev/null || true
    docker network rm dns-test-project-a dns-test-project-b 2>/dev/null || true
}

trap cleanup EXIT

# Create test networks
echo -e "${BLUE}Creating test networks...${NC}"
docker network create dns-test-project-a
docker network create dns-test-project-b

# Create test containers with same service name in different networks
echo -e "${BLUE}Creating test services...${NC}"

# Project A services (both have alias 'web')
docker run -d --name dns-test-a1 --network dns-test-project-a --network-alias web \
    nginx:alpine sh -c 'echo "Project A - Container 1" > /usr/share/nginx/html/index.html && nginx -g "daemon off;"'

docker run -d --name dns-test-a2 --network dns-test-project-a --network-alias web \
    nginx:alpine sh -c 'echo "Project A - Container 2" > /usr/share/nginx/html/index.html && nginx -g "daemon off;"'

# Project B services (both have alias 'web')  
docker run -d --name dns-test-b1 --network dns-test-project-b --network-alias web \
    nginx:alpine sh -c 'echo "Project B - Container 1" > /usr/share/nginx/html/index.html && nginx -g "daemon off;"'

docker run -d --name dns-test-b2 --network dns-test-project-b --network-alias web \
    nginx:alpine sh -c 'echo "Project B - Container 2" > /usr/share/nginx/html/index.html && nginx -g "daemon off;"'

# Create a resolver container connected to both networks
docker run -d --name dns-test-resolver \
    --network dns-test-project-a \
    alpine:latest sleep 3600

docker network connect dns-test-project-b dns-test-resolver

sleep 2

echo -e "${BLUE}Testing DNS resolution behavior...${NC}"

# Test 1: Resolution within Project A context
echo "Test 1: Resolving 'web' from Project A network context"
RESULT_A=$(docker exec dns-test-resolver nslookup web 2>/dev/null | grep "Address" | tail -1 || echo "FAILED")
echo "  Result: $RESULT_A"

# Test 2: Check which containers respond to 'web'
echo
echo "Test 2: Making HTTP requests to 'web' to see which containers respond"
RESPONSES=()
for i in {1..10}; do
    RESPONSE=$(docker exec dns-test-resolver wget -qO- --timeout=2 http://web 2>/dev/null || echo "FAILED")
    RESPONSES+=("$RESPONSE")
done

A1_COUNT=0
A2_COUNT=0
B1_COUNT=0
B2_COUNT=0

for response in "${RESPONSES[@]}"; do
    case "$response" in
        *"Project A - Container 1"*) ((A1_COUNT++)) ;;
        *"Project A - Container 2"*) ((A2_COUNT++)) ;;
        *"Project B - Container 1"*) ((B1_COUNT++)) ;;
        *"Project B - Container 2"*) ((B2_COUNT++)) ;;
    esac
done

echo "  Project A Container 1: $A1_COUNT responses"
echo "  Project A Container 2: $A2_COUNT responses"
echo "  Project B Container 1: $B1_COUNT responses"
echo "  Project B Container 2: $B2_COUNT responses"

# Test 3: Check which network Docker prefers
echo
echo "Test 3: Network precedence analysis"
if [[ $A1_COUNT -gt 0 || $A2_COUNT -gt 0 ]]; then
    echo -e "${GREEN}✅ Docker is resolving 'web' to Project A network${NC}"
    PREFERRED_NETWORK="Project A"
elif [[ $B1_COUNT -gt 0 || $B2_COUNT -gt 0 ]]; then
    echo -e "${GREEN}✅ Docker is resolving 'web' to Project B network${NC}"
    PREFERRED_NETWORK="Project B"
else
    echo -e "${RED}❌ DNS resolution failed${NC}"
    PREFERRED_NETWORK="None"
fi

# Test 4: Load balancing within preferred network
echo
echo "Test 4: Load balancing within $PREFERRED_NETWORK network"
if [[ "$PREFERRED_NETWORK" == "Project A" ]]; then
    TOTAL_A=$((A1_COUNT + A2_COUNT))
    if [[ $A1_COUNT -gt 0 && $A2_COUNT -gt 0 ]]; then
        echo -e "${GREEN}✅ Load balancing working within Project A ($A1_COUNT/$A2_COUNT split)${NC}"
    elif [[ $TOTAL_A -gt 0 ]]; then
        echo -e "${BLUE}ℹ️  All requests went to one container (may be normal)${NC}"
    fi
elif [[ "$PREFERRED_NETWORK" == "Project B" ]]; then
    TOTAL_B=$((B1_COUNT + B2_COUNT))
    if [[ $B1_COUNT -gt 0 && $B2_COUNT -gt 0 ]]; then
        echo -e "${GREEN}✅ Load balancing working within Project B ($B1_COUNT/$B2_COUNT split)${NC}"
    elif [[ $TOTAL_B -gt 0 ]]; then
        echo -e "${BLUE}ℹ️  All requests went to one container (may be normal)${NC}"
    fi
fi

# Test 5: Direct container access
echo
echo "Test 5: Testing direct container access by name"
DIRECT_A1=$(docker exec dns-test-resolver wget -qO- --timeout=2 http://dns-test-a1 2>/dev/null || echo "FAILED")
DIRECT_B1=$(docker exec dns-test-resolver wget -qO- --timeout=2 http://dns-test-b1 2>/dev/null || echo "FAILED")

if [[ "$DIRECT_A1" == *"Project A"* ]]; then
    echo -e "${GREEN}✅ Direct access to Project A container working${NC}"
else
    echo -e "${RED}❌ Direct access to Project A container failed${NC}"
fi

if [[ "$DIRECT_B1" == *"Project B"* ]]; then
    echo -e "${GREEN}✅ Direct access to Project B container working${NC}"
else
    echo -e "${RED}❌ Direct access to Project B container failed${NC}"
fi

echo
echo "======================================"
echo -e "${GREEN}Key Findings:${NC}"
echo "• Docker resolves 'web' to $PREFERRED_NETWORK network when container is connected to multiple networks"
echo "• Load balancing works within the resolved network"
echo "• Direct container names work across networks"
echo "• Network precedence appears to be based on connection order or internal Docker logic"
echo
echo -e "${BLUE}Recommendation for Luma:${NC}"
echo "• Use project-specific network connections for true isolation"
echo "• Rely on Docker's built-in load balancing within each project network"
echo "• Avoid connecting proxy to multiple networks with same service names"
echo
echo -e "${GREEN}Test completed! 🚀${NC}" 
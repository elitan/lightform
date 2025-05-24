#!/bin/bash

# --- Configuration ---
TARGET_URL="https://test.eliasson.me" # <<< IMPORTANT: Replace with your actual URL
CONCURRENT_REQUESTS=10                # Number of requests to send concurrently
DELAY_BETWEEN_BATCHES=0.1            # Short delay in seconds between sending batches
VERBOSE=false                        # Set to true for detailed output

# Colors for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Counters
TOTAL_REQUESTS=0
SUCCESSFUL_REQUESTS=0
FAILED_REQUESTS=0
BATCH_COUNT=0

# Temporary files for tracking results from background processes
SUCCESS_FILE=$(mktemp)
FAILURE_FILE=$(mktemp)

# Cleanup function
cleanup() {
    rm -f "$SUCCESS_FILE" "$FAILURE_FILE"
}

# Ensure cleanup on exit
trap 'cleanup' EXIT

echo -e "${CYAN}🚀 Starting load test${NC}"
echo -e "${BLUE}Target:${NC} $TARGET_URL"
echo -e "${BLUE}Concurrent requests per batch:${NC} $CONCURRENT_REQUESTS"
echo -e "${BLUE}Delay between batches:${NC} ${DELAY_BETWEEN_BATCHES}s"
echo -e "${YELLOW}Press Ctrl+C to stop and see final results${NC}"
echo ""

# Function to update status line
update_status() {
    local success_rate=0
    if [ $TOTAL_REQUESTS -gt 0 ]; then
        success_rate=$(echo "scale=1; $SUCCESSFUL_REQUESTS * 100 / $TOTAL_REQUESTS" | bc -l)
    fi
    printf "\r${CYAN}Batch #%d${NC} | ${GREEN}✓ %d${NC} | ${RED}✗ %d${NC} | ${BLUE}Total: %d${NC} | ${YELLOW}Success: %s%%${NC}" \
        $BATCH_COUNT $SUCCESSFUL_REQUESTS $FAILED_REQUESTS $TOTAL_REQUESTS $success_rate
}

# Function to send a single curl request
send_request() {
    local request_id=$1
    local start_time=$(date +%s.%N)
    
    if [ "$VERBOSE" = true ]; then
        echo -e "${BLUE}[Request $request_id]${NC} Starting..."
    fi
    
    # Send request silently and capture HTTP status code
    local http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$TARGET_URL")
    local curl_exit_code=$?
    local end_time=$(date +%s.%N)
    local duration=$(echo "scale=3; $end_time - $start_time" | bc -l)
    
    # Write results to temporary files (this works from background processes)
    if [ "$curl_exit_code" -eq 0 ] && [ "$http_code" -ge 200 ] && [ "$http_code" -lt 400 ]; then
        echo "1" >> "$SUCCESS_FILE"
        if [ "$VERBOSE" = true ]; then
            echo -e "${GREEN}[Request $request_id]${NC} ✓ HTTP $http_code (${duration}s)"
        fi
    else
        echo "1" >> "$FAILURE_FILE"
        if [ "$VERBOSE" = true ]; then
            if [ "$curl_exit_code" -ne 0 ]; then
                echo -e "${RED}[Request $request_id]${NC} ✗ Connection failed (${duration}s)"
            else
                echo -e "${RED}[Request $request_id]${NC} ✗ HTTP $http_code (${duration}s)"
            fi
        fi
    fi
}

# Function to update counters from temporary files
update_counters() {
    # Count successful requests
    if [ -f "$SUCCESS_FILE" ]; then
        SUCCESSFUL_REQUESTS=$(wc -l < "$SUCCESS_FILE" | tr -d ' ')
    else
        SUCCESSFUL_REQUESTS=0
    fi
    
    # Count failed requests
    if [ -f "$FAILURE_FILE" ]; then
        FAILED_REQUESTS=$(wc -l < "$FAILURE_FILE" | tr -d ' ')
    else
        FAILED_REQUESTS=0
    fi
    
    # Calculate total
    TOTAL_REQUESTS=$((SUCCESSFUL_REQUESTS + FAILED_REQUESTS))
}

# Function to show final results
show_final_results() {
    echo ""
    echo ""
    echo -e "${CYAN}📊 Final Results${NC}"
    echo -e "${BLUE}═══════════════════════════════════════${NC}"
    echo -e "${BLUE}Total requests sent:${NC} $TOTAL_REQUESTS"
    echo -e "${GREEN}Successful requests:${NC} $SUCCESSFUL_REQUESTS"
    echo -e "${RED}Failed requests:${NC} $FAILED_REQUESTS"
    echo -e "${BLUE}Total batches:${NC} $BATCH_COUNT"
    
    if [ $TOTAL_REQUESTS -gt 0 ]; then
        local success_rate=$(echo "scale=2; $SUCCESSFUL_REQUESTS * 100 / $TOTAL_REQUESTS" | bc -l)
        echo -e "${YELLOW}Success rate:${NC} ${success_rate}%"
        
        if [ $(echo "$success_rate >= 95" | bc -l) -eq 1 ]; then
            echo -e "${GREEN}🎉 Excellent! Your service is performing well.${NC}"
        elif [ $(echo "$success_rate >= 80" | bc -l) -eq 1 ]; then
            echo -e "${YELLOW}⚠️  Good, but could be improved.${NC}"
        else
            echo -e "${RED}❌ Poor performance detected. Investigation needed.${NC}"
        fi
    fi
    echo ""
}

# Trap CTRL+C to show final results and exit cleanly
trap 'update_counters; show_final_results; exit 0' INT

# Check if verbose mode requested
if [ "$1" = "-v" ] || [ "$1" = "--verbose" ]; then
    VERBOSE=true
    echo -e "${YELLOW}Verbose mode enabled${NC}"
    echo ""
fi

# --- Main loop ---
while true; do
    BATCH_COUNT=$((BATCH_COUNT + 1))
    
    # Send concurrent requests
    for i in $(seq 1 $CONCURRENT_REQUESTS); do
        send_request $i &
    done
    
    # Wait for all requests in current batch to complete
    wait
    
    # Update counters from temporary files
    update_counters
    
    # Update status line (non-verbose mode)
    if [ "$VERBOSE" = false ]; then
        update_status
    fi
    
    sleep $DELAY_BETWEEN_BATCHES
done
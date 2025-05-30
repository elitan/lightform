#!/bin/bash

# --- Configuration ---
LOAD_BALANCER_URL="https://test.eliasson.me" # IMPORTANT: Replace with your actual URL
TEST_DURATION="10s" # How long each test should run (e.g., 10 seconds)
CONCURRENCY=50     # Number of concurrent connections
NUMBER_OF_REQUESTS=0 # If 0, hey will run for TEST_DURATION. If set, it will run for this many requests.
OUTPUT_FILE="hey_results.json"
LOG_FILE="load_test.log"

# --- Functions ---

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

run_hey_test() {
    local target_url=$1
    log "Starting hey test on $target_url..."
    log "Duration: $TEST_DURATION, Concurrency: $CONCURRENCY"

    if [ "$NUMBER_OF_REQUESTS" -gt 0 ]; then
        hey_command="hey -n $NUMBER_OF_REQUESTS -c $CONCURRENCY -o json \"$target_url\""
    else
        hey_command="hey -z $TEST_DURATION -c $CONCURRENCY -o json \"$target_url\""
    fi

    log "Executing: $hey_command"
    eval "$hey_command" > "$OUTPUT_FILE" 2>> "$LOG_FILE"

    if [ $? -eq 0 ]; then
        log "hey test completed successfully. Results saved to $OUTPUT_FILE."
    else
        log "Error: hey test failed. Check $LOG_FILE for details."
        return 1
    fi
}

parse_hey_results() {
    if [ ! -f "$OUTPUT_FILE" ]; then
        log "Error: Output file $OUTPUT_FILE not found."
        return 1
    fi

    log "Parsing hey results from $OUTPUT_FILE..."

    # Use jq to extract key metrics
    local total_requests=$(jq '.totalRequests' "$OUTPUT_FILE")
    local total_duration=$(jq '.totalDuration' "$OUTPUT_FILE")
    local requests_per_second=$(jq '.rps' "$OUTPUT_FILE")
    local p90_latency_ms=$(jq '.latency.p90 / 1000000' "$OUTPUT_FILE") # Convert ns to ms
    local p99_latency_ms=$(jq '.latency.p99 / 1000000' "$OUTPUT_FILE") # Convert ns to ms
    local http_errors=$(jq '.errorDist."200"' "$OUTPUT_FILE") # Example: Count 200 OK responses

    # Calculate actual HTTP errors (status codes other than 2xx normally)
    local total_responses=$(jq '.totalRequests' "$OUTPUT_FILE")
    local success_2xx_responses=$(jq '[.statusCodeDist | to_entries[] | select(.key | startswith("2")) | .value] | add' "$OUTPUT_FILE")
    local non_2xx_responses=$((total_responses - success_2xx_responses))

    log "--- Test Results for $LOAD_BALANCER_URL ---"
    log "Total Requests: $total_requests"
    log "Total Duration: $(printf "%.2f" $(echo "$total_duration / 1000000000" | bc -l)) seconds" # Convert ns to seconds
    log "Requests per Second (RPS): $(printf "%.2f" $requests_per_second)"
    log "P90 Latency: $(printf "%.2f" $p90_latency_ms) ms"
    log "P99 Latency: $(printf "%.2f" $p99_latency_ms) ms"
    log "Non-2xx HTTP Responses: $non_2xx_responses (out of $total_responses total)"
    log "-------------------------------------------"

    # You can add more parsing here as needed
}

# --- Main Script Execution ---

# Check for `hey` and `jq`
if ! command -v hey &> /dev/null; then
    log "Error: 'hey' command not found. Please install it (e.g., go install github.com/rakyll/hey@latest)."
    exit 1
fi
if ! command -v jq &> /dev/null; then
    log "Error: 'jq' command not found. Please install it (e.g., sudo apt-get install jq or brew install jq)."
    exit 1
fi

# Clean up previous output
rm -f "$OUTPUT_FILE" "$LOG_FILE"

# Run the test
run_hey_test "$LOAD_BALANCER_URL"

# Parse and display results
if [ $? -eq 0 ]; then
    parse_hey_results
else
    log "Test failed, skipping result parsing."
fi

log "Script finished."
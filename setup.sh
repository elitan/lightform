#!/bin/bash
set -e

# Build the Luma service
echo "Building Luma service..."
cd src
go build -o ../bin/luma ./cmd/server

cd ..

# Create the network for communication between Caddy and containers
echo "Creating Docker network..."
docker network create luma-net 2>/dev/null || true

# Start Caddy
echo "Starting Caddy..."
docker-compose up -d

# Start the Luma service on the host
echo "Starting Luma service..."
./bin/luma -port=8080

# Note: You'll need to modify the Caddyfile with your actual domain
# and restart Caddy if you make changes:
# docker-compose restart caddy
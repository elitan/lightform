#!/bin/bash

set -e

echo "🚀 Publishing Luma Proxy to Docker Hub..."

# Ensure we're in the proxy directory
cd "$(dirname "$0")"

# Check if we're logged into Docker Hub
if ! docker info | grep -q "Username"; then
    echo "⚠️  Please login to Docker Hub first: docker login"
    exit 1
fi

# Build multi-platform image and push
echo "📦 Building multi-platform image..."
docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --tag elitan/luma-proxy:latest \
    --push \
    .

echo "✅ Successfully published elitan/luma-proxy:latest"
echo "📖 Image is available at: https://hub.docker.com/r/elitan/luma-proxy" 
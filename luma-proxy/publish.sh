#!/bin/bash
set -e

# Configuration
IMAGE_NAME="elitan/luma-proxy"
VERSION="latest"

# Display what we're doing
echo "Building and publishing $IMAGE_NAME:$VERSION..."

# Build the Docker image
echo "Building image..."
docker build -t $IMAGE_NAME:$VERSION .

# Push to Docker registry
echo "Publishing image to registry..."
docker push $IMAGE_NAME:$VERSION

echo "Done! Image $IMAGE_NAME:$VERSION has been published."

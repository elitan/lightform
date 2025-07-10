#!/bin/bash
set -e

# Configuration
IMAGE_NAME="elitan/lightform-proxy"
VERSION="latest"
PLATFORMS="linux/amd64,linux/arm64"

# Display what we're doing
echo "Building and publishing multi-platform image $IMAGE_NAME:$VERSION for platforms: $PLATFORMS..."

# Create a new builder instance if it doesn't exist
BUILDER_NAME="lightform-multiplatform-builder"
if ! docker buildx inspect $BUILDER_NAME > /dev/null 2>&1; then
  echo "Creating new buildx builder instance..."
  docker buildx create --name $BUILDER_NAME --driver docker-container --use
else
  echo "Using existing buildx builder instance..."
  docker buildx use $BUILDER_NAME
fi

# Ensure the builder is running
docker buildx inspect --bootstrap

# Build the Docker image for multiple platforms using buildx
echo "Building image with buildx..."
docker buildx build --platform $PLATFORMS -t $IMAGE_NAME:$VERSION --push .

echo "Done! Multi-platform image $IMAGE_NAME:$VERSION has been published."
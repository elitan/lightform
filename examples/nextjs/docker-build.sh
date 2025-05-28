#!/bin/bash

# Docker build and run script for Next.js app

echo "Building Docker image..."
docker build -t nextjs-app .

echo "Running Docker container..."
docker run -p 3000:3000 --name nextjs-container -d nextjs-app

echo "Docker container is running on http://localhost:3000"
echo "To stop the container, run: docker stop nextjs-container"
echo "To remove the container, run: docker rm nextjs-container" 
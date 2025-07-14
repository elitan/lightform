# Start from the official Golang image
FROM golang:1.22-alpine

# Accept build arguments from lightform build.env
ARG EXAMPLE_VAR

# Set the Current Working Directory inside the container
WORKDIR /app

# Copy go.mod first for better caching
COPY go.mod ./

# Copy source code
COPY main.go ./

# Build the Go app (can use EXAMPLE_VAR during build)
RUN echo "Building with EXAMPLE_VAR=${EXAMPLE_VAR}" && \
    CGO_ENABLED=0 GOOS=linux go build -o main .

# Expose port 80 to the outside world
EXPOSE 80

# Command to run the executable
CMD ["./main"] 
# Stage 1: Build the Go application
FROM --platform=$BUILDPLATFORM golang:1.21-alpine AS builder

WORKDIR /app

# Copy go.mod and go.sum files to download dependencies
COPY go.mod ./
# It's good practice to also copy go.sum if it exists and you run `go mod download` or `go mod tidy`
# RUN go mod download 

# Copy the source code
COPY . .

# Build the application
# -ldflags "-w -s" reduces the size of the binary by removing debug information.
ARG TARGETOS TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -ldflags "-w -s" -o /luma-proxy cmd/luma-proxy/main.go

# Stage 2: Create the final lightweight image
FROM alpine:latest

# Add ca-certificates, curl for health checks, and docker CLI for backend resolution
RUN apk --no-cache add ca-certificates curl docker

WORKDIR /app

# Copy the built binary from the builder stage
COPY --from=builder /luma-proxy .

# Create directories for certificates and configuration
RUN mkdir -p /var/lib/luma-proxy/certs && \
    chmod 700 /var/lib/luma-proxy/certs

# Expose ports 80 and 443
EXPOSE 80 443

# Set the entrypoint for the container
ENTRYPOINT ["/app/luma-proxy"]

# Default command is to run the proxy
CMD ["run"] 
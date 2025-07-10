# Build stage
FROM golang:1.21-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git

# Set working directory
WORKDIR /build

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the binary
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o lightform-proxy ./cmd/lightform-proxy

# Runtime stage
FROM alpine:3.18

# Install ca-certificates for HTTPS and curl for health checks
RUN apk --no-cache add ca-certificates curl

# Create directories
RUN mkdir -p /var/lib/lightform-proxy/certs

# Copy binary from builder
COPY --from=builder /build/lightform-proxy /usr/local/bin/lightform-proxy

# Make binary executable
RUN chmod +x /usr/local/bin/lightform-proxy

# Expose ports
EXPOSE 80 443

# Volume for persistent data
VOLUME ["/var/lib/lightform-proxy"]

# Run the proxy
ENTRYPOINT ["/usr/local/bin/lightform-proxy"] 
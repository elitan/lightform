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
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o iop-proxy ./cmd/iop-proxy

# Runtime stage
FROM alpine:3.18

# Install ca-certificates for HTTPS and curl for health checks
RUN apk --no-cache add ca-certificates curl

# Create directories
RUN mkdir -p /var/lib/iop-proxy/certs

# Copy binary from builder
COPY --from=builder /build/iop-proxy /usr/local/bin/iop-proxy

# Make binary executable
RUN chmod +x /usr/local/bin/iop-proxy

# Expose ports
EXPOSE 80 443

# Volume for persistent data
VOLUME ["/var/lib/iop-proxy"]

# Run the proxy
ENTRYPOINT ["/usr/local/bin/iop-proxy"] 
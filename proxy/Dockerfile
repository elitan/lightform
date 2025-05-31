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
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o luma-proxy ./cmd/luma-proxy

# Runtime stage
FROM alpine:3.18

# Install ca-certificates for HTTPS
RUN apk --no-cache add ca-certificates

# Create directories
RUN mkdir -p /var/lib/luma-proxy/certs

# Copy binary from builder
COPY --from=builder /build/luma-proxy /usr/local/bin/luma-proxy

# Make binary executable
RUN chmod +x /usr/local/bin/luma-proxy

# Expose ports
EXPOSE 80 443

# Volume for persistent data
VOLUME ["/var/lib/luma-proxy"]

# Run the proxy
ENTRYPOINT ["/usr/local/bin/luma-proxy"] 
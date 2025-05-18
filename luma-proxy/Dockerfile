# Stage 1: Build the Go application
FROM golang:1.21-alpine AS builder

WORKDIR /app

# Copy go.mod and go.sum files to download dependencies
COPY go.mod ./
# It's good practice to also copy go.sum if it exists and you run `go mod download` or `go mod tidy`
# RUN go mod download 

# Copy the source code
COPY . .

# Build the application
# -ldflags "-w -s" reduces the size of the binary by removing debug information.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags "-w -s" -o /luma-proxy cmd/luma-proxy/main.go

# Stage 2: Create the final lightweight image
FROM alpine:latest

# Add ca-certificates and curl for health checks
RUN apk --no-cache add ca-certificates curl

WORKDIR /app

# Copy the built binary from the builder stage
COPY --from=builder /luma-proxy .

# Expose ports 80 and 443
EXPOSE 80 443

# Set the entrypoint for the container
ENTRYPOINT ["./luma-proxy", "run"] 
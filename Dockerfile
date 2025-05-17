FROM golang:1.23-alpine AS builder

WORKDIR /app

# Copy go.mod and go.sum files
COPY go.mod go.sum ./
RUN go mod download

# Copy the source code
COPY . .

# Build the application
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o luma .

# Use a small image for the final container
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /app/

# Copy the binary from the builder stage
COPY --from=builder /app/luma .

# Create a non-root user
RUN addgroup -S luma && adduser -S luma -G luma
USER luma

# Set environment variables
ENV LUMA_PROXY_PORT=8080
ENV LUMA_API_PORT=8081
ENV LUMA_INACTIVITY_TIMEOUT=20
ENV LUMA_CHECK_INTERVAL=3
ENV LUMA_SERVER_ADDRESS=localhost
ENV LUMA_CLOUDFLARE_ENABLED=false

# Expose ports
EXPOSE 8080 8081

# Run the application
CMD ["./luma"]
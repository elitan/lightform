# Start from the official Golang image to build the executable
FROM golang:1.22-alpine AS builder

# Set the Current Working Directory inside the container
WORKDIR /app

# Copy source code
COPY main.go go.mod ./

# No need for go.sum since we don't have external dependencies
# Initialize the module if needed
RUN go mod tidy

# Build the Go app
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o main .

# Start a new stage from scratch for a smaller image
FROM alpine:latest

WORKDIR /root/

# Copy the Pre-built binary file from the previous stage
COPY --from=builder /app/main .

# Expose port 80 to the outside world
EXPOSE 80

# Command to run the executable
CMD ["./main"] 
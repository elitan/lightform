# Luma Proxy

Luma Proxy is a lightweight, Go-based reverse proxy designed to be a **persistent, always-on service** (daemon) on your target server(s). It acts as the central entry point for all incoming HTTP/S traffic to your Luma-managed applications.

The Luma Proxy binary operates in two modes:

1.  **Daemon Mode (`luma-proxy run`):** Starts the proxy server, listens for public traffic (on ports 80/443), and manages routing rules and SSL certificates. It also listens on an internal Unix domain socket for management commands.
2.  **Client Mode (`luma-proxy <command> [args]`):** Sends management commands (e.g., to deploy a service, remove a service, update SSL settings) to the running Luma Proxy daemon via the Unix domain socket.

The `Luma CLI` (e.g., during `luma deploy`) will use `docker exec` to run `luma-proxy` in client mode inside the Luma Proxy container, thereby configuring the running daemon.

The Luma Proxy daemon handles:

- Routing requests to the appropriate application containers based on hostname.
- Automatic SSL/TLS termination via Let's Encrypt.
- HTTP to HTTPS redirection.

## Running Locally (for development & testing client/daemon interaction)

1.  **Build the binary/image:**
    ```bash
    cd luma-proxy
    docker build -t luma-proxy .
    # Or, for local Go builds: go build -o luma-proxy main.go
    ```
2.  **Run the Luma Proxy daemon in a container:**
    ```bash
    # (Ensure a directory for the socket is available if needed, e.g., /run/luma-proxy/)
    # This example assumes the socket will be at /tmp/luma-proxy.sock inside the container for simplicity.
    docker run -d --name luma-proxy-daemon -v /tmp:/tmp luma-proxy run --socket-path /tmp/luma-proxy.sock
    # The daemon will also listen on its public ports (e.g., 8080 for now, eventually 80/443)
    ```
3.  **Send commands using the client mode via `docker exec`:**
    ```bash
    docker exec luma-proxy-daemon ./luma-proxy deploy my-app --host app.example.com --target 172.17.0.2:3000 --socket-path /tmp/luma-proxy.sock
    docker exec luma-proxy-daemon ./luma-proxy list-services --socket-path /tmp/luma-proxy.sock
    ```

## Configuration Management (via Client CLI & Unix Socket)

The Luma Proxy daemon is managed imperatively by sending commands to it using the `luma-proxy` binary in client mode. This communication happens over a Unix domain socket (e.g., `/run/luma-proxy/management.sock` or a configurable path).

The `Luma CLI` orchestrates these client commands. Based on your project's `luma.yml` and the Luma CLI commands you issue (e.g., `luma deploy <app-name>`), the Luma CLI will construct and execute the appropriate `luma-proxy client` commands inside the proxy container using `docker exec`.

**Key `luma-proxy` client commands will include (conceptual):**

- `luma-proxy deploy <service-name> --host <hostname> --target <ip:port> [--ssl] [--ssl-redirect] [--forward-headers] [--response-timeout <duration>] [--socket-path <path>]`: Adds or updates a route for a service, specifying its backend target, host for routing, and other proxy behaviors.
- `luma-proxy remove <service-name> [--host <hostname>] [--socket-path <path>]`: Removes a service or a specific host from a service.
- `luma-proxy get-service <service-name> [--socket-path <path>]`: Retrieves the current configuration for a service.
- `luma-proxy list-services [--socket-path <path>]`: Lists all configured services and their routes.
- `luma-proxy set-global-option --lets-encrypt-email <email> [--socket-path <path>]`: Sets global options like the Let's Encrypt email.

**Example Workflow (Luma CLI deploying `my-webapp`):**

1.  Luma CLI reads the `proxy` configuration for `my-webapp` from `luma.yml`.
2.  It determines the IP address and port of the newly deployed `my-webapp` container.
3.  Luma CLI executes a command inside the Luma Proxy container:
    ```bash
    docker exec <luma-proxy-container-id> \
        ./luma-proxy deploy my-webapp \
            --host my-app.example.com \
            --target <container_ip>:<app_port> \
            --ssl \
            [--socket-path /run/luma-proxy/management.sock] # Optional if default is known
    ```
4.  The `luma-proxy deploy` client process connects to the daemon's Unix socket, sends the command details.
5.  The Luma Proxy daemon receives the command, updates its internal routing table and SSL settings, and starts proxying traffic accordingly.

The Luma Proxy daemon maintains its state internally based on the sequence of commands received. Persistence of this state across daemon restarts might be handled by the daemon writing to a state file, or by Luma CLI re-applying configurations when it detects a fresh proxy instance.

## Todos

- [ ] **CLI & Daemon Structure in `main.go`:**
  - [ ] Implement argument parsing (e.g., using `flag` or a library like `cobra/urfave/cli`) to differentiate `run` mode from client commands.
  - [ ] Structure `main.go` to call daemon logic or client logic based on parsed arguments.
- [ ] **Daemon Mode (`luma-proxy run`):**
  - [ ] Implement Unix domain socket listener.
  - [ ] Define and implement the protocol for commands received over the socket (e.g., JSON-RPC, custom simple protocol).
  - [ ] Implement handler logic for each command (deploy, remove, list, etc.).
  - [ ] Reverse proxy core logic using `net/http/httputil.ReverseProxy` based on dynamic internal state.
  - [ ] Listen on public HTTP/HTTPS ports (80/443).
- [ ] **Client Mode (`luma-proxy <command>`):**
  - [ ] For each command (deploy, remove, etc.), implement logic to connect to the daemon's Unix socket.
  - [ ] Send the command and its arguments to the daemon according to the defined protocol.
  - [ ] Receive and display any response/status from the daemon.
- [ ] **Internal State Management (in daemon):**
  - [ ] Design data structures for active routing rules, SSL configs, etc.
  - [ ] Ensure thread-safe access and modification.
  - [ ] Decide on and implement state persistence (e.g., write to a file on changes, Luma CLI re-populates on start).
- [ ] **HTTPS/SSL (Let's Encrypt - triggered by `deploy --ssl`):**
  - [ ] Integrate `golang.org/x/crypto/acme/autocert`.
  - [ ] Manage certificate storage (persistent volume, e.g., `/etc/luma-proxy/certs`).
- [ ] **Feature Implementation (controlled via client commands):**
  - [ ] HTTP to HTTPS redirection.
  - [ ] Header Forwarding.
  - [ ] Response Timeouts.
- [ ] **Global Options:** Handle global settings like Let's Encrypt email (e.g., via `luma-proxy set-global-option` or initial env var for the daemon).
- [ ] **Graceful Shutdown (daemon):** Allow existing connections and commands to complete.
- [ ] **Health Check Endpoint:** For the proxy daemon itself (`/luma-proxy-health`, accessible via public port).
- [ ] **Testing:** Unit tests for client/daemon logic, command handlers, and integration tests for client-daemon communication.

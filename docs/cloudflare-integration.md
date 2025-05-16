# Cloudflare Integration

Luma now supports automatic domain assignment through Cloudflare's API. This integration allows each project to be assigned a unique domain based on its name.

## How It Works

When Cloudflare integration is enabled:

1. Each new project registered with Luma can be automatically assigned a subdomain of your base domain.
2. DNS records are created in your Cloudflare account to point to your Luma server.
3. The domains are automatically proxied through Cloudflare, providing SSL/TLS and other Cloudflare benefits.

## Configuration

Cloudflare integration can be configured using environment variables or a JSON configuration file.

### Environment Variables

```sh
# Enable Cloudflare integration
LUMA_CLOUDFLARE_ENABLED=true

# Your Cloudflare API token with DNS edit permissions
LUMA_CLOUDFLARE_API_TOKEN=your_api_token_here

# The Zone ID for your domain (found in Cloudflare dashboard)
LUMA_CLOUDFLARE_ZONE_ID=your_zone_id_here

# The base domain for your projects (e.g., example.com)
LUMA_CLOUDFLARE_BASE_DOMAIN=example.com

# Whether to automatically generate domains on project registration
LUMA_CLOUDFLARE_AUTO_GENERATE=true

# Your server's public IP or hostname
LUMA_SERVER_ADDRESS=your.server.com
```

### Configuration File

```json
{
  "proxy_server_port": ":8080",
  "api_server_port": ":8081",
  "inactivity_timeout": 20,
  "check_interval": 3,
  "server_address": "your.server.com",
  "cloudflare": {
    "enabled": true,
    "api_token": "your_api_token_here",
    "zone_id": "your_zone_id_here",
    "base_domain": "example.com",
    "auto_generate": true
  }
}
```

## API Endpoints

### Domain Management

Luma provides several API endpoints for managing domains:

#### Get Domain for Project
```
GET /domains/{hostname}
```

Returns domain information for a project by its hostname.

#### List All Domains
```
GET /domains
```

Returns a list of all domains managed by Luma.

#### Create Domain for Project
```
POST /domains/{hostname}
```

Creates a new domain for an existing project.

#### Delete Domain for Project
```
DELETE /domains/{hostname}
```

Deletes the domain for a project.

## Project Registration with Domains

When registering a new project with Cloudflare integration enabled, the response will include domain information:

```json
{
  "message": "Project registered successfully: my-app",
  "project": {
    "name": "my-app",
    "docker_image": "nginx",
    "env_vars": {},
    "container_port": 80,
    "hostname": "my-app.localhost"
  },
  "domain": {
    "project_hostname": "my-app.localhost",
    "domain": "my-app.example.com",
    "dns_record": {
      "record_id": "dns-record-id",
      "name": "my-app.example.com",
      "content": "your.server.com",
      "type": "A",
      "proxied": true
    }
  }
}
```

## Limitations

- The integration automatically creates A records pointing to your server.
- Domain names are generated based on the project name with special characters removed.
- All domains are automatically proxied through Cloudflare.
- DNS propagation may take some time after domain creation.
# Luma Deployment Tool MVP

Luma is a CLI tool designed to simplify the process of building, deploying, and managing containerized web applications on remote servers via SSH.

## Prerequisites

- Bun (https://bun.sh/)
- Docker installed locally and on target servers

## Setup

1.  Clone the repository (or create the project structure).
2.  Install dependencies: `bun install`
3.  Make the CLI executable: `chmod +x src/index.ts` (if running directly)

## Configuration

1.  Run `bun run src/index.ts init` or `./src/index.ts init` (if executable) to create example configuration files:
    - `config/luma.yml.example`
    - `.luma/secrets.example`
2.  Rename `config/luma.yml.example` to `config/luma.yml` and customize it for your services and servers.
3.  Rename `.luma/secrets.example` to `.luma/secrets` and add your sensitive information.

## Usage

- Initialize Luma configuration: `luma init`
- Set up servers (install Docker, login to registry): `luma setup [service_name...]`
- Deploy services: `luma deploy [service_name...]`
- Redeploy services (rebuilds and pushes image): `luma redeploy [service_name...]`
- Rollback a service to a previous version: `luma rollback <service_name> <version_id>`

## Development

Run the CLI directly:
`bun run src/index.ts <command>`

Or, after `bun link` or global installation:
`luma <command>`

To make it globally available for development:

1.  `bun link` in the project directory.

This will make the `luma` command available in your shell.

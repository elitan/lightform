import { z } from "zod";

// TypeScript types for configuration will go here

// Zod schema for common server definition (can be string or object)
// For now, let's assume servers are always strings (hostnames/IPs) as used in setup.ts
// If object-based server defs are needed later, this can be expanded.
// const ServerConfigSchema = z.union([z.string(), z.object({ host: z.string(), port: z.number().optional() })]);

// Zod schema for HealthCheck (primarily for Apps)
export const HealthCheckSchema = z.object({
  command: z.array(z.string()).optional(), // For Dockerfile HEALTHCHECK CMD
  http_path: z.string().optional(), // For HTTP health checks
  interval: z.string().optional(), // e.g., "30s"
  timeout: z.string().optional(), // e.g., "5s"
  retries: z.number().optional(),
  start_period: z.string().optional(), // e.g., "60s"
  // We no longer need endpoint and port as they're hardcoded to /up and 80
});
export type HealthCheckConfig = z.infer<typeof HealthCheckSchema>;

// Zod schema for App-specific Proxy Configuration
export const AppProxyConfigSchema = z.object({
  hosts: z.array(z.string()).optional(),
  app_port: z
    .number()
    .describe(
      "Port the application container is exposed on, e.g. 3000. The proxy will forward traffic to this port."
    )
    .optional(),
  ssl: z
    .boolean()
    .describe(
      "Enable automatic HTTPS via Let's Encrypt. Requires 'hosts' to be set and DNS to point to the server."
    )
    .optional()
    .default(false),
  ssl_redirect: z
    .boolean()
    .describe("Redirect HTTP to HTTPS if SSL is enabled. Defaults to true.")
    .optional(),
  forward_headers: z
    .boolean()
    .describe(
      "Forward X-Forwarded-For/Proto headers. Default depends on SSL status (true if SSL disabled, false if SSL enabled, unless overridden)."
    )
    .optional(),
  response_timeout: z
    .string()
    .describe("Request timeout, e.g., '30s', '1m'. Default is '30s'.")
    .optional(),
});
export type AppProxyConfig = z.infer<typeof AppProxyConfigSchema>;

// Zod schema for Global Proxy Options
export const GlobalProxyOptionsSchema = z.object({
  lets_encrypt_email: z
    .string()
    .email()
    .describe("Email address for Let's Encrypt registration.")
    .optional(),
});
export type GlobalProxyOptions = z.infer<typeof GlobalProxyOptionsSchema>;

// Zod schema for AppEntry without name (used in record format)
export const AppEntryWithoutNameSchema = z.object({
  image: z.string(),
  servers: z.array(z.string()), // For now, simple array of hostnames/IPs
  build: z
    .object({
      context: z.string(),
      dockerfile: z.string().default("Dockerfile"),
      args: z.record(z.string()).optional(), // Build arguments
      target: z.string().optional(), // For multi-stage builds
      platform: z.string().optional(), // e.g., linux/amd64
    })
    .optional(),
  ports: z.array(z.string()).optional(), // e.g., ["80:80", "443:443"]
  volumes: z.array(z.string()).optional(), // e.g., ["mydata:/data/db"]
  environment: z
    .object({
      plain: z.array(z.string()).optional(), // Use array format for environment variables
      secret: z.array(z.string()).optional(), // Array of secret keys to pull from LumaSecrets
    })
    .optional(),
  registry: z // Optional per-app registry override
    .object({
      url: z.string().optional(),
      username: z.string(),
      password_secret: z.string(), // Secret key for the password
    })
    .optional(),
  health_check: HealthCheckSchema.optional(),
  proxy: AppProxyConfigSchema.optional(),
  // Potentially add other app-specific fields like 'replicas', 'domains', etc.
});
export type AppEntryWithoutName = z.infer<typeof AppEntryWithoutNameSchema>;

// Zod schema for AppEntry (includes name - for array format if needed)
export const AppEntrySchema = AppEntryWithoutNameSchema.extend({
  name: z.string(),
});
export type AppEntry = z.infer<typeof AppEntrySchema>;

// Zod schema for ServiceEntry without name (used in record format)
export const ServiceEntryWithoutNameSchema = z.object({
  image: z.string(), // Includes tag, e.g., "postgres:15"
  servers: z.array(z.string()),
  ports: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  environment: z
    .object({
      plain: z.array(z.string()).optional(), // Use array format for environment variables
      secret: z.array(z.string()).optional(),
    })
    .optional(),
  registry: z // Optional per-service registry override
    .object({
      url: z.string().optional(),
      username: z.string(),
      password_secret: z.string(), // Secret key for the password
    })
    .optional(),
});
export type ServiceEntryWithoutName = z.infer<
  typeof ServiceEntryWithoutNameSchema
>;

// Zod schema for ServiceEntry (includes name - for array format if needed)
export const ServiceEntrySchema = ServiceEntryWithoutNameSchema.extend({
  name: z.string(),
});
export type ServiceEntry = z.infer<typeof ServiceEntrySchema>;

// Zod schema for LumaConfig - allowing both object and array formats for apps and services
export const LumaConfigSchema = z.object({
  name: z.string().min(1, "Project name is required"), // Used for network naming etc.
  apps: z
    .union([
      z.record(AppEntryWithoutNameSchema), // Object format where keys are app names
      z.array(AppEntrySchema), // Array format with explicit name field
    ])
    .optional(),
  services: z
    .union([
      z.record(ServiceEntryWithoutNameSchema), // Object format where keys are service names
      z.array(ServiceEntrySchema), // Array format with explicit name field
    ])
    .optional(),
  docker: z
    .object({
      registry: z.string().optional(), // Global Docker registry
      username: z.string().optional(), // Global username
      // Global password_secret should be defined in LumaSecrets and referenced
      // e.g. global_docker_password_secret: "DOCKER_REGISTRY_PASSWORD"
    })
    .optional(),
  ssh: z
    .object({
      username: z.string().optional(), // Default SSH username
      port: z.number().optional(), // Default SSH port
      // Default key path can be a LumaSecret reference, e.g. default_ssh_key_secret: "DEFAULT_SSH_KEY_PATH"
    })
    .optional(),
  proxy_options: GlobalProxyOptionsSchema.optional(),
});
export type LumaConfig = z.infer<typeof LumaConfigSchema>;

// Zod schema for LumaSecrets (simple key-value)
export const LumaSecretsSchema = z.record(z.string());
export type LumaSecrets = z.infer<typeof LumaSecretsSchema>;

import { z } from "zod";

// Zod schema for HealthCheck
export const HealthCheckSchema = z.object({
  path: z.string().optional().default("/up"), // Health check endpoint path
});
export type HealthCheckConfig = z.infer<typeof HealthCheckSchema>;

// Zod schema for Proxy Configuration (for HTTP services)
export const ProxyConfigSchema = z.object({
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
    .default(true),
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
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

// Zod schema for unified Service Entry without name (used in record format)
export const ServiceEntryWithoutNameSchema = z.object({
  image: z.string().optional(), // e.g., "postgres:15" or "my-app/web" - optional when build is specified
  server: z.string().describe("Hostname or IP address of the target server"),
  replicas: z
    .number()
    .min(1)
    .default(1)
    .describe("Number of replicas to deploy for this service. Defaults to 1."),
  build: z
    .object({
      context: z.string(),
      dockerfile: z.string().default("Dockerfile"),
      args: z.array(z.string()).optional().describe(
        "Build arguments passed to Docker build command. List of environment variable names to pass as build args. These variables must be defined in the environment section."
      ),
      target: z.string().optional(), // For multi-stage builds
      platform: z.string().optional(), // e.g., linux/amd64
    })
    .optional()
    .describe(
      "Build configuration. When specified, the service is built locally and transferred via docker save/load instead of using registries."
    ),
  ports: z.array(z.string()).optional(), // e.g., ["3000", "5432:5432"]
  volumes: z.array(z.string()).optional(), // e.g., ["mydata:/data/db"]
  environment: z
    .object({
      plain: z.array(z.string()).optional(), // Array format for environment variables like ["KEY=VALUE"]
      secret: z.array(z.string()).optional(),
    })
    .optional(),
  registry: z // Optional registry for pre-built images
    .object({
      url: z.string().optional(),
      username: z.string(),
      password_secret: z.string(), // Secret key for the password
    })
    .optional()
    .describe(
      "Registry configuration for pre-built images. Not used for services with 'build' configuration."
    ),
  command: z.string().optional().describe("Override the default command for the container"),
  health_check: HealthCheckSchema.optional(),
  proxy: ProxyConfigSchema.optional(),
}).refine((data) => {
  // Ensure either image or build is provided, but not both
  const hasImage = !!data.image;
  const hasBuild = !!data.build;
  return hasImage !== hasBuild; // XOR: exactly one must be true
}, {
  message: "Service must have either 'image' or 'build', but not both",
  path: ["image"],
});
export type ServiceEntryWithoutName = z.infer<typeof ServiceEntryWithoutNameSchema>;

// Zod schema for ServiceEntry (includes name - for array format if needed)
export const ServiceEntrySchema = z.object({
  name: z.string(),
  image: z.string().optional(), // e.g., "postgres:15" or "my-app/web" - optional when build is specified
  server: z.string().describe("Hostname or IP address of the target server"),
  replicas: z
    .number()
    .min(1)
    .default(1)
    .describe("Number of replicas to deploy for this service. Defaults to 1."),
  build: z
    .object({
      context: z.string(),
      dockerfile: z.string().default("Dockerfile"),
      args: z.array(z.string()).optional().describe(
        "Build arguments passed to Docker build command. List of environment variable names to pass as build args. These variables must be defined in the environment section."
      ),
      target: z.string().optional(), // For multi-stage builds
      platform: z.string().optional(), // e.g., linux/amd64
    })
    .optional()
    .describe(
      "Build configuration. When specified, the service is built locally and transferred via docker save/load instead of using registries."
    ),
  ports: z.array(z.string()).optional(), // e.g., ["3000", "5432:5432"]
  volumes: z.array(z.string()).optional(), // e.g., ["mydata:/data/db"]
  environment: z
    .object({
      plain: z.array(z.string()).optional(), // Array format for environment variables like ["KEY=VALUE"]
      secret: z.array(z.string()).optional(),
    })
    .optional(),
  registry: z // Optional registry for pre-built images
    .object({
      url: z.string().optional(),
      username: z.string(),
      password_secret: z.string(), // Secret key for the password
    })
    .optional()
    .describe(
      "Registry configuration for pre-built images. Not used for services with 'build' configuration."
    ),
  command: z.string().optional().describe("Override the default command for the container"),
  health_check: HealthCheckSchema.optional(),
  proxy: ProxyConfigSchema.optional(),
}).refine((data) => {
  // Ensure either image or build is provided, but not both
  const hasImage = !!data.image;
  const hasBuild = !!data.build;
  return hasImage !== hasBuild; // XOR: exactly one must be true
}, {
  message: "Service must have either 'image' or 'build', but not both",
  path: ["image"],
});
export type ServiceEntry = z.infer<typeof ServiceEntrySchema>;

// Legacy types for backward compatibility (will be removed)
export type AppEntry = ServiceEntry;
export type AppEntryWithoutName = ServiceEntryWithoutName;
export const AppEntrySchema = ServiceEntrySchema;
export const AppEntryWithoutNameSchema = ServiceEntryWithoutNameSchema;
export type AppProxyConfig = ProxyConfig;

// Zod schema for IopConfig - unified services model
export const IopConfigSchema = z.object({
  name: z.string().min(1, "Project name is required"), // Used for network naming etc.
  services: z
    .union([
      z.record(ServiceEntryWithoutNameSchema), // Object format where keys are service names
      z.array(ServiceEntrySchema), // Array format with explicit name field
    ])
    .optional(),
  // Legacy support - will be merged into services
  apps: z
    .union([
      z.record(ServiceEntryWithoutNameSchema), // Object format where keys are app names
      z.array(ServiceEntrySchema), // Array format with explicit name field
    ])
    .optional(),
  docker: z
    .object({
      registry: z
        .string()
        .optional()
        .describe(
          "Global Docker registry (optional - only needed for services using private registries)"
        ), // Global Docker registry
      username: z.string().optional().describe("Global registry username"), // Global username
      // Global password_secret should be defined in IopSecrets and referenced
      // e.g. global_docker_password_secret: "DOCKER_REGISTRY_PASSWORD"
    })
    .optional()
    .describe(
      "Global Docker registry configuration. Optional - only needed for services using private registries. Apps with build configuration use docker save/load transfer."
    ),
  ssh: z
    .object({
      username: z.string().optional(), // Default SSH username
      port: z.number().optional(), // Default SSH port
      key_file: z.string().optional(), // Path to SSH private key file
    })
    .optional(),
  proxy: z
    .object({
      image: z
        .string()
        .describe("Custom Docker image for the iop proxy")
        .optional(),
    })
    .optional(),
});
export type IopConfig = z.infer<typeof IopConfigSchema>;

// Zod schema for IopSecrets (simple key-value)
export const IopSecretsSchema = z.record(z.string());
export type IopSecrets = z.infer<typeof IopSecretsSchema>;

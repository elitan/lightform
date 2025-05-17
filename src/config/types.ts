import { z } from "zod";

// TypeScript types for configuration will go here

// Zod schema for LumaService
export const LumaServiceSchema = z.object({
  image: z.string(),
  servers: z.array(z.string()),
  build: z
    .object({
      context: z.string(),
      dockerfile: z.string(),
    })
    .optional(),
  ports: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  environment: z
    .object({
      plain: z.array(z.string()).optional(),
      secret: z.array(z.string()).optional(),
    })
    .optional(),
  registry: z
    .object({
      url: z.string().optional(),
      username: z.string(),
      password: z.array(z.string()),
    })
    .optional(),
});

// Infer TypeScript type for LumaService
export type LumaService = z.infer<typeof LumaServiceSchema>;

// Zod schema for LumaConfig
export const LumaConfigSchema = z.object({
  name: z.string().optional(), // Project name, used for network naming
  services: z.record(LumaServiceSchema),
  docker: z
    .object({
      // Global Docker settings
      registry: z.string().optional(),
      username: z.string().optional(),
      // Password should come from secrets, not in luma.yml
    })
    .optional(),
  ssh: z
    .object({
      username: z.string().optional(),
      port: z.number().optional(),
    })
    .optional(),
});

// Infer TypeScript type for LumaConfig
export type LumaConfig = z.infer<typeof LumaConfigSchema>;

// Zod schema for LumaSecrets (simple key-value)
export const LumaSecretsSchema = z.record(z.string());

// Infer TypeScript type for LumaSecrets
export type LumaSecrets = z.infer<typeof LumaSecretsSchema>;

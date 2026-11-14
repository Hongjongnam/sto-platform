import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  RPC_URL: z.url(),
  DEPLOYMENT_FILE: z.string().min(1),
  CHAIN_MNEMONIC: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL: z.string().default('8h'),
  /** Enables the public demo endpoints under /demo. Never turn this on for a real deployment. */
  DEMO_MODE: z.enum(['on', 'off']).default('off'),
});

export type Env = z.infer<typeof envSchema>;

/** Validates process environment at startup; the app refuses to start on a bad configuration. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}

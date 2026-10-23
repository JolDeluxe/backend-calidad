import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SERVER_HOST: z.string().default("127.0.0.1"),
  TRUST_PROXY: z
    .string()
    .default("false")
    .transform((val) => val === "true" || val === "1"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatoria"),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((val) => (val.includes(",") ? val.split(",").map((s) => s.trim()) : [val.trim()])),

  SESSION_DURATION_DAYS: z.coerce.number().default(3650),
  ACCESS_TOKEN_EXPIRES_MINUTES: z.coerce.number().default(15),
  SESSION_COOKIE_NAME: z.string().default("auth_session"),
  SESSION_COOKIE_HTTP_ONLY: z
    .string()
    .default("true")
    .transform((val) => val === "true" || val === "1"),
  SESSION_COOKIE_SECURE: z
    .string()
    .default("false")
    .transform((val) => val === "true" || val === "1"),
  SESSION_COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().default(10000),

  JWT_SECRET: z.string().min(32, "JWT_SECRET debe tener al menos 32 caracteres"),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("❌ Variables de entorno inválidas o faltantes:");
  console.error(parsedEnv.error.format());
  process.exit(1);
}

export const env = parsedEnv.data;
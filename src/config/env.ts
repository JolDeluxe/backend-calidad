import { z } from "zod";

const envSchema = z
  .object({
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

    // Rutas opcionales para archivos de catálogo e histórico
    CATALOGO_DEFECTOS_PATH: z.string().optional(),
    HISTORICO_DEFECTOS_DIR: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    // Validaciones estrictas exclusivas para producción
    if (data.NODE_ENV === "production") {
      // 1. JWT_SECRET no debe ser el valor de desarrollo genérico ni débil
      const weakSecrets = [
        "calidad-super-secret-jwt-key-2026-production-ready",
        "secret",
        "12345678901234567890123456789012",
        "cambiar_este_jwt_secret_en_produccion_12345",
      ];
      if (weakSecrets.includes(data.JWT_SECRET.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "En producción, JWT_SECRET debe ser una clave criptográficamente robusta generada aleatoriamente y no un valor por defecto o conocido.",
          path: ["JWT_SECRET"],
        });
      }

      // 2. Coherencia de Cookies Seguras
      if (process.env.SESSION_COOKIE_SECURE === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "En producción se debe configurar explícitamente SESSION_COOKIE_SECURE ('true' o 'false').",
          path: ["SESSION_COOKIE_SECURE"],
        });
      }

      // 3. Si SameSite es 'none', Secure DEBE ser true obligatoriamente por especificación de navegadores
      if (data.SESSION_COOKIE_SAME_SITE === "none" && !data.SESSION_COOKIE_SECURE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Si SESSION_COOKIE_SAME_SITE es 'none', SESSION_COOKIE_SECURE debe ser 'true' obligatoriamente.",
          path: ["SESSION_COOKIE_SECURE"],
        });
      }

      // 4. Validación estricta de CORS_ORIGINS en producción
      if (process.env.CORS_ORIGINS === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "En producción se debe definir explícitamente CORS_ORIGINS con los dominios autorizados de la aplicación.",
          path: ["CORS_ORIGINS"],
        });
      }

      const hasWildcard = data.CORS_ORIGINS.includes("*");
      if (hasWildcard) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "En producción, CORS_ORIGINS no puede contener comodines ('*') cuando se transmiten credenciales/cookies.",
          path: ["CORS_ORIGINS"],
        });
      }

      const hasLocalhost = data.CORS_ORIGINS.some((origin) =>
        origin.includes("localhost") || origin.includes("127.0.0.1")
      );
      if (hasLocalhost && process.env.ALLOW_INSECURE_LOCAL_ORIGINS !== "true") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "En producción, CORS_ORIGINS no debe contener orígenes localhost o 127.0.0.1 salvo excepción explícita con ALLOW_INSECURE_LOCAL_ORIGINS=true.",
          path: ["CORS_ORIGINS"],
        });
      }
    }
  });

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("❌ Variables de entorno inválidas o faltantes:");
  console.error(parsedEnv.error.format());
  process.exit(1);
}

export const env = parsedEnv.data;

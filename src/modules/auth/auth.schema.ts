import { z } from "zod";

export const loginSchema = z.object({
  usuario: z.string().min(1, "El usuario es obligatorio"),
  password: z.string().min(1, "La contraseña es obligatoria"),
});

export const exchangeOfflineTokenSchema = z.object({
  offlineToken: z.string().min(1, "El token offline es obligatorio"),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ExchangeOfflineTokenInput = z.infer<typeof exchangeOfflineTokenSchema>;
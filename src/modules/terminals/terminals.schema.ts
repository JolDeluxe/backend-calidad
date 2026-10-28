import { z } from "zod";

// 1. Alta inicial presencial de terminal (SUPER_ADMIN)
export const createTerminalSchema = z.object({
  nombre: z
    .string()
    .trim()
    .min(3, "El nombre de la terminal debe tener al menos 3 caracteres")
    .max(60, "El nombre de la terminal no debe exceder los 60 caracteres")
    .optional(),
  departamentoId: z.coerce
    .number({ required_error: "Debe seleccionar un departamento válido" })
    .int("El ID de departamento debe ser un entero")
    .positive("Debe seleccionar un departamento válido"),
});

// 2. Reasignación de departamento de terminal (SUPER_ADMIN)
export const reasignarTerminalSchema = z.object({
  departamentoId: z.coerce
    .number({ required_error: "Debe seleccionar un departamento válido" })
    .int("El ID de departamento debe ser un entero")
    .positive("Debe seleccionar un departamento válido"),
  motivo: z
    .string()
    .trim()
    .max(255, "El motivo no debe exceder los 255 caracteres")
    .optional(),
});

// 3. Revocación o bloqueo de terminal (SUPER_ADMIN)
export const revocarTerminalSchema = z.object({
  motivo: z
    .string()
    .trim()
    .max(255, "El motivo no debe exceder los 255 caracteres")
    .optional(),
});

// 4. Parámetros de ruta con ID de terminal (:id)
export const terminalIdParamSchema = z.object({
  id: z.coerce
    .number({ required_error: "ID de terminal requerido" })
    .int("El ID de terminal debe ser un entero")
    .positive("ID de terminal inválido"),
});

// 4.1 Solicitud de código de recuperación OTP (SUPER_ADMIN)
export const solicitarRecuperacionSchema = z.object({
  terminalId: z.coerce
    .number({ required_error: "ID de terminal requerido" })
    .int("El ID de terminal debe ser un entero")
    .positive("ID de terminal inválido"),
});

// 5. Canje de código de recuperación OTP desde la PC física
export const canjearRecuperacionSchema = z.object({
  codigo: z
    .string({ required_error: "El código de recuperación es obligatorio" })
    .trim()
    .regex(/^\d{6}$/, "El código de recuperación debe ser exactamente de 6 dígitos numéricos"),
});

// Tipos inferidos
export type CreateTerminalInput = z.infer<typeof createTerminalSchema>;
export type ReasignarTerminalInput = z.infer<typeof reasignarTerminalSchema>;
export type RevocarTerminalInput = z.infer<typeof revocarTerminalSchema>;
export type SolicitarRecuperacionInput = z.infer<typeof solicitarRecuperacionSchema>;
export type CanjearRecuperacionInput = z.infer<typeof canjearRecuperacionSchema>;

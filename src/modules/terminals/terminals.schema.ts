import { z } from "zod";

// 1. Alta inicial presencial de terminal (SUPER_ADMIN)
export const createTerminalSchema = z.object({
  nombre: z
    .string()
    .trim()
    .min(2, "El nombre de la terminal debe tener al menos 2 caracteres")
    .max(60, "El nombre de la terminal no debe exceder los 60 caracteres")
    .optional(),
  departamentoId: z.coerce
    .number({ required_error: "Debe seleccionar un departamento válido" })
    .int("El ID de departamento debe ser un entero")
    .positive("Debe seleccionar un departamento válido"),
  departamentosIds: z
    .array(z.coerce.number().int().positive())
    .optional(),
});

// 2. Reasignación de departamento principal de terminal (SUPER_ADMIN)
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

// 2.1 Cambio de nombre visible personalizado de terminal (SUPER_ADMIN)
export const renameTerminalSchema = z.object({
  nombre: z
    .string({ required_error: "El nombre de la terminal es obligatorio" })
    .trim()
    .min(2, "El nombre de la terminal debe tener al menos 2 caracteres")
    .max(60, "El nombre de la terminal no debe exceder los 60 caracteres"),
  motivo: z
    .string()
    .trim()
    .max(255, "El motivo no debe exceder los 255 caracteres")
    .optional(),
});

// 2.2 Configuración multidepartamental y designación de principal de terminal (SUPER_ADMIN)
export const updateTerminalDepartamentosSchema = z
  .object({
    departamentosIds: z
      .array(z.coerce.number().int().positive())
      .min(1, "La terminal debe tener al menos un departamento asociado"),
    departamentoPrincipalId: z.coerce
      .number({ required_error: "Debe seleccionar el departamento principal" })
      .int("El ID del departamento principal debe ser un entero")
      .positive("Debe seleccionar un departamento principal válido"),
    motivo: z
      .string()
      .trim()
      .max(255, "El motivo no debe exceder los 255 caracteres")
      .optional(),
  })
  .refine((data) => data.departamentosIds.includes(data.departamentoPrincipalId), {
    message:
      "El departamento designado como principal debe formar parte de los departamentos asociados",
    path: ["departamentoPrincipalId"],
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

// 6. Verificación de autorización de Super Administrador para contingencias o desvinculación
export const verificarAutorizacionSuperAdminSchema = z.object({
  superAdminId: z.coerce
    .number({ required_error: "ID de SuperAdmin requerido" })
    .int("El ID de SuperAdmin debe ser un entero")
    .positive("ID de SuperAdmin inválido"),
  password: z
    .string({ required_error: "La contraseña es requerida" })
    .min(1, "La contraseña es requerida"),
  accion: z
    .string({ required_error: "La acción es requerida" })
    .trim()
    .min(3, "La acción debe tener al menos 3 caracteres")
    .max(100, "La acción no debe exceder los 100 caracteres"),
  motivo: z
    .string()
    .trim()
    .max(255, "El motivo no debe exceder los 255 caracteres")
    .optional(),
  terminalId: z.coerce
    .number()
    .int("El ID de terminal debe ser un entero")
    .positive("ID de terminal inválido")
    .optional(),
});


// Tipos inferidos
export type CreateTerminalInput = z.infer<typeof createTerminalSchema>;
export type ReasignarTerminalInput = z.infer<typeof reasignarTerminalSchema>;
export type RevocarTerminalInput = z.infer<typeof revocarTerminalSchema>;
export type SolicitarRecuperacionInput = z.infer<typeof solicitarRecuperacionSchema>;
export type CanjearRecuperacionInput = z.infer<typeof canjearRecuperacionSchema>;

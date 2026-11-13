import { z } from "zod";

export const createUserSchema = z.object({
  nombre: z.string().min(2, "El nombre debe tener al menos 2 caracteres"),
  password: z.string().min(3, "La contraseña debe tener al menos 3 dígitos"),
  rolId: z.number().int().positive("Debe seleccionar un rol válido"),
});

export const updateUserSchema = z.object({
  nombre: z.string().min(2, "El nombre debe tener al menos 2 caracteres").optional(),
  password: z.string().min(3, "La contraseña debe tener al menos 3 dígitos").optional(),
  rolId: z.number().int().positive().optional(),
  estado: z.enum(["ACTIVO", "INACTIVO"]).optional(),
});

export const userIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const suggestUsernameQuerySchema = z.object({
  nombre: z.string().min(1, "El nombre es obligatorio"),
  excludeId: z.coerce.number().int().positive().optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type SuggestUsernameQuery = z.infer<typeof suggestUsernameQuerySchema>;

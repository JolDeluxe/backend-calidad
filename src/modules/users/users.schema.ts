import { z } from "zod";

export const createUserSchema = z.object({
  usuario: z.string().min(3, "El usuario debe tener al menos 3 caracteres"),
  nombre: z.string().min(1, "El nombre es obligatorio"),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
  rolId: z.number().int().positive(),
});

export const updateUserSchema = z.object({
  nombre: z.string().min(1).optional(),
  rolId: z.number().int().positive().optional(),
  estado: z.enum(["ACTIVO", "INACTIVO"]).optional(),
});

export const userIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
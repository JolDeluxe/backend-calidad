import { z } from "zod";

export const categoriaDepartamentoIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, "El ID debe ser un número entero positivo"),
});

export const getCategoriasDepartamentoQuerySchema = z.object({
  activo: z
    .string()
    .transform((val) => val === "true")
    .optional(),
  busqueda: z.string().trim().optional(),
  incluirEliminados: z
    .string()
    .transform((val) => val === "true")
    .optional(),
});

export const createCategoriaDepartamentoSchema = z.object({
  nombre: z
    .string()
    .min(1, "El nombre de la categoría es obligatorio")
    .max(100, "El nombre no debe exceder 100 caracteres")
    .trim()
    .refine((val) => val.length > 0, "El nombre no puede consistir únicamente en espacios"),
  descripcion: z.string().max(255).optional().nullable(),
  activo: z.boolean().optional().default(true),
});

export const updateCategoriaDepartamentoSchema = z.object({
  nombre: z
    .string()
    .min(1, "El nombre de la categoría no puede estar vacío")
    .max(100, "El nombre no debe exceder 100 caracteres")
    .trim()
    .refine((val) => val.length > 0, "El nombre no puede consistir únicamente en espacios")
    .optional(),
  descripcion: z.string().max(255).optional().nullable(),
  activo: z.boolean().optional(),
});

export const updateEstadoCategoriaDepartamentoSchema = z.object({
  activo: z.boolean({ required_error: "El campo activo es obligatorio" }),
});

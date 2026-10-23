import { z } from "zod";

export const tipoOperacionIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, "El ID debe ser un número entero positivo"),
});

export const lineaIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, "El ID debe ser un número entero positivo"),
});

export const createTipoOperacionSchema = z.object({
  codigo: z
    .string()
    .min(1, "El código es obligatorio")
    .max(30, "El código no debe superar 30 caracteres")
    .trim()
    .transform((val) => val.toUpperCase()),
  nombre: z
    .string()
    .min(1, "El nombre es obligatorio")
    .max(100, "El nombre no debe superar 100 caracteres")
    .trim(),
  descripcion: z.string().max(255).optional().nullable(),
});

export const updateTipoOperacionSchema = z.object({
  nombre: z
    .string()
    .min(1, "El nombre es obligatorio")
    .max(100, "El nombre no debe superar 100 caracteres")
    .trim()
    .optional(),
  descripcion: z.string().max(255).optional().nullable(),
  estado: z.enum(["ACTIVO", "INACTIVO"]).optional(),
});

export const updateEstadoTipoOperacionSchema = z.object({
  estado: z.enum(["ACTIVO", "INACTIVO"], { required_error: "El estado debe ser ACTIVO o INACTIVO" }),
});

export const createLineaSchema = z.object({
  tipoOperacionId: z.number().int().positive("El tipo de operación es obligatorio"),
  codigo: z
    .string()
    .min(1, "El código es obligatorio")
    .max(30, "El código no debe superar 30 caracteres")
    .trim()
    .transform((val) => val.toUpperCase()),
  nombre: z
    .string()
    .min(1, "El nombre es obligatorio")
    .max(100, "El nombre no debe superar 100 caracteres")
    .trim(),
  descripcion: z.string().max(255).optional().nullable(),
});

export const updateLineaSchema = z.object({
  nombre: z
    .string()
    .min(1, "El nombre es obligatorio")
    .max(100, "El nombre no debe superar 100 caracteres")
    .trim()
    .optional(),
  descripcion: z.string().max(255).optional().nullable(),
  estado: z.enum(["ACTIVO", "INACTIVO"]).optional(),
});

export const updateEstadoLineaSchema = z.object({
  estado: z.enum(["ACTIVO", "INACTIVO"], { required_error: "El estado debe ser ACTIVO o INACTIVO" }),
});

export const syncLineaDepartamentosSchema = z.object({
  departamentos: z.array(
    z.object({
      departamentoId: z.number().int().positive(),
      activo: z.boolean(),
      orden: z.number().int().min(0).optional(),
    })
  ),
});

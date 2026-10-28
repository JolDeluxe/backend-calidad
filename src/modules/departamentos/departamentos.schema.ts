import { z } from "zod";

export const departamentoIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, "El ID debe ser un número entero positivo"),
});

export const getDepartamentosQuerySchema = z.object({
  lineaId: z.string().regex(/^\d+$/).transform(Number).optional(),
  tipoOperacionId: z.string().regex(/^\d+$/).transform(Number).optional(),
  categoriaDepartamentoId: z.string().regex(/^\d+$/).transform(Number).optional(),
  estado: z.enum(["ACTIVO", "INACTIVO"]).optional(),
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

export const createDepartamentoSchema = z.object({
  codigo: z
    .string()
    .max(30, "El código no debe superar 30 caracteres")
    .trim()
    .transform((val) => val.toUpperCase())
    .optional(),
  nombre: z
    .string()
    .min(1, "El nombre es obligatorio")
    .max(100, "El nombre no debe superar 100 caracteres")
    .trim(),
  categoriaDepartamentoId: z.number().int().positive().nullable().optional(),
  numeroLineas: z.number().int().min(1, "El número de líneas debe ser al menos 1").max(10, "El número de líneas máximo es 10").optional(),
  lineasIds: z.array(z.number().int().positive()).optional(),
});

export const updateDepartamentoSchema = z.object({
  nombre: z
    .string()
    .min(1, "El nombre es obligatorio")
    .max(100, "El nombre no debe superar 100 caracteres")
    .trim()
    .optional(),
  codigo: z
    .string()
    .min(1, "El código no puede estar vacío")
    .max(30, "El código no debe superar 30 caracteres")
    .trim()
    .transform((val) => val.toUpperCase())
    .optional(),
  categoriaDepartamentoId: z.number().int().positive().nullable().optional(),
  numeroLineas: z.number().int().min(1, "El número de líneas debe ser al menos 1").max(10, "El número de líneas máximo es 10").optional(),
  lineasIds: z.array(z.number().int().positive()).optional(),
});

export const updateEstadoDepartamentoSchema = z.object({
  estado: z.enum(["ACTIVO", "INACTIVO"]),
});

export const syncDepartamentoLineasSchema = z.object({
  lineas: z.array(
    z.object({
      lineaId: z.number().int().positive(),
      activo: z.boolean(),
    })
  ),
});

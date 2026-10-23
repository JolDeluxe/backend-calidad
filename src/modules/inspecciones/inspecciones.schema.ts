import { z } from "zod";

export const itemDefectoCaptureSchema = z.object({
  defectoId: z.number().int().positive("El ID del defecto debe ser un entero positivo"),
  defDeptoId: z.number().int().positive("El ID del departamento responsable debe ser un entero positivo").optional(),
  paresDefectuosos: z.number().int().min(1, "Debe registrarse al menos 1 par defectuoso"),
  notas: z.string().trim().max(255).optional(),
});

export const createInspeccionSchema = z.object({
  lote: z.string().trim().min(1, "El código de lote es obligatorio"),
  lineaId: z.number().int().positive("El ID de línea debe ser válido").optional().nullable(),
  departamentoAuditoriaId: z.number().int().positive("El ID del departamento auditor es obligatorio").optional(),
  horma: z.string().trim().max(60).optional().nullable(),
  notas: z.string().trim().max(500).optional().nullable(),
  detalles: z
    .array(itemDefectoCaptureSchema)
    .min(1, "Debe registrar al menos un defecto en la inspección"),
});

export const getInspeccionesQuerySchema = z.object({
  periodo: z.enum(["hoy", "ultimos", "todos"]).default("ultimos"),
  busqueda: z.string().trim().optional(),
  lote: z.string().trim().optional(),
  defectoClave: z.coerce.number().int().positive().optional(),
  departamentoAuditoriaId: z.coerce.number().int().positive().optional(),
  inspectorId: z.coerce.number().int().positive().optional(),
  mes: z.coerce.number().int().min(1).max(12).optional(),
  anio: z.coerce.number().int().min(2020).max(2035).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(30),
});

export const inspeccionIdParamSchema = z.object({
  id: z.coerce.number().int().positive("El ID de la inspección debe ser un entero positivo"),
});

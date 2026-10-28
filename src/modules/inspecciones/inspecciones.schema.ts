import { z } from "zod";

export const itemDefectoCaptureSchema = z.object({
  defectoId: z.number().int().positive("El ID del defecto debe ser un entero positivo"),
  defDeptoId: z.number().int().positive("El ID del departamento responsable debe ser un entero positivo").optional(),
  paresDefectuosos: z.number().int().min(1, "Debe registrarse al menos 1 par defectuoso"),
  notas: z.string().trim().max(255).optional(),
});

// El departamento de auditoría NO forma parte del contrato: lo determina exclusivamente la terminal validada.
export const createInspeccionSchema = z.object({
  lote: z.string().trim().min(1, "El código de lote es obligatorio"),
  lineaId: z.number().int().positive("El ID de línea debe ser válido").optional().nullable(),
  lineaTexto: z.string().trim().max(30).optional().nullable(),
  horma: z.string().trim().max(60).optional().nullable(),
  notas: z.string().trim().max(500).optional().nullable(),
  detalles: z
    .array(itemDefectoCaptureSchema)
    .min(1, "Debe registrar al menos un defecto en la inspección")
    .max(100, "Demasiados defectos en una sola captura"),
});

/** Clave de idempotencia enviada en el encabezado `Idempotency-Key`. */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8, "La clave de idempotencia es demasiado corta")
  .max(64, "La clave de idempotencia es demasiado larga")
  .regex(/^[A-Za-z0-9_-]+$/, "La clave de idempotencia contiene caracteres no válidos");

const fechaQuerySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener formato AAAA-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`)), "Fecha no válida");

export const MAX_RANGO_DIAS_HISTORIAL = 366;

export const getInspeccionesQuerySchema = z
  .object({
    periodo: z.enum(["hoy", "ultimos", "todos"]).default("ultimos"),
    busqueda: z.string().trim().max(100).optional(),
    lote: z.string().trim().max(30).optional(),
    defectoClave: z.coerce.number().int().positive().optional(),
    departamentoId: z.coerce.number().int().positive().optional(),
    departamentoAuditoriaId: z.coerce.number().int().positive().optional(),
    departamentoResponsableId: z.coerce.number().int().positive().optional(),
    clasificacion: z.enum(["CRITICO", "MAYOR", "MENOR"]).optional(),
    lineaId: z.coerce.number().int().positive().optional(),
    lineaTexto: z.string().trim().max(30).optional(),
    inspectorId: z.coerce.number().int().positive().optional(),
    terminalId: z.coerce.number().int().positive().optional(),
    fechaDesde: fechaQuerySchema.optional(),
    fechaHasta: fechaQuerySchema.optional(),
    mes: z.coerce.number().int().min(1).max(12).optional(),
    anio: z.coerce.number().int().min(2020).max(2035).optional(),
    soloEliminados: z.preprocess((val) => val === "true" || val === true, z.boolean()).optional(),
    page: z.coerce.number().int().positive().max(100000).default(1),
    limit: z.coerce.number().int().positive().max(200).default(30),
  })
  .superRefine((q, ctx) => {
    if (q.fechaDesde && q.fechaHasta) {
      const d = Date.parse(`${q.fechaDesde}T00:00:00.000Z`);
      const h = Date.parse(`${q.fechaHasta}T00:00:00.000Z`);
      if (d > h) {
        ctx.addIssue({ code: "custom", path: ["fechaDesde"], message: "fechaDesde no puede ser posterior a fechaHasta" });
      } else if ((h - d) / 86_400_000 > MAX_RANGO_DIAS_HISTORIAL) {
        ctx.addIssue({
          code: "custom",
          path: ["fechaHasta"],
          message: `El rango de fechas no puede exceder ${MAX_RANGO_DIAS_HISTORIAL} días`,
        });
      }
    }
  });

export const inspeccionIdParamSchema = z.object({
  id: z.coerce.number().int().positive("El ID de la inspección debe ser un entero positivo"),
});

export const detalleIdParamSchema = z.object({
  id: z.coerce.number().int().positive("El ID del detalle debe ser un entero positivo"),
});

export const detalleIncluirQuerySchema = z.object({
  incluirEliminados: z.preprocess((val) => val === "true" || val === true, z.boolean()).optional(),
});

// Eliminar o recuperar un defecto en inspecciones
export const eliminacionLogicaSchema = z.object({
  motivo: z.string().trim().max(255).optional(),
  // Código de confirmación tecleado en la interfaz (verificación de intención)
  codigoConfirmacion: z.string().trim().optional(),
}).refine(
  (data) => {
    // Si viene código de confirmación (desde interfaz de usuario), el motivo es 100% opcional
    if (data.codigoConfirmacion && data.codigoConfirmacion.length === 6) {
      return true;
    }
    // Si se envía vía API sin código de confirmación o con motivo definido, validar motivo
    if (data.motivo !== undefined) {
      return data.motivo.length >= 3;
    }
    return false;
  },
  {
    message: "El motivo debe ser proporcionado (mínimo 3 caracteres) si no se provee código de confirmación",
    path: ["motivo"],
  }
);

export const cancelarDetalleSchema = eliminacionLogicaSchema;

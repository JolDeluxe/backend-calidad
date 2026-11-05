import { z } from "zod";
import {
  esFechaIsoValida,
  getPartesFechaMexico,
  getIsoYearAndWeek,
  getMaxSemanasIsoEnAnio,
  getRangoSemanaIsoUtc,
} from "../../utils/timezone";

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
  .refine((v) => esFechaIsoValida(v), "Fecha no válida en el calendario")
  .refine((v) => Number(v.slice(0, 4)) >= 2020, "La fecha no puede ser anterior al año 2020");

export const modalidadPeriodoEnum = z.enum([
  "hoy",
  "ultimos",
  "todos",
  "anio",
  "mes",
  "semana",
  "dia",
  "rango",
]);

const filtrosComunesInspeccionesShape = {
  periodo: modalidadPeriodoEnum.default("ultimos"),
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
  dia: fechaQuerySchema.optional(),
  semana: z.coerce.number().int().min(1).max(53).optional(),
  anioIso: z.coerce.number().int().min(2020).max(2100).optional(),
  mes: z.coerce.number().int().min(1).max(12).optional(),
  anio: z.coerce.number().int().min(2020).max(2100).optional(),
  soloEliminados: z.preprocess((val) => val === "true" || val === true, z.boolean()).optional(),
};

function validarReglasTemporalesInspeccion(
  q: {
    periodo?: string;
    fechaDesde?: string;
    fechaHasta?: string;
    dia?: string;
    semana?: number;
    anioIso?: number;
    mes?: number;
    anio?: number;
  },
  ctx: z.RefinementCtx
): void {
  const hoyMexico = getPartesFechaMexico();
  const hoyStr = hoyMexico.fechaStr;

  if (q.fechaDesde && q.fechaDesde > hoyStr) {
    ctx.addIssue({
      code: "custom",
      path: ["fechaDesde"],
      message: "La fecha inicial (fechaDesde) no puede ser una fecha futura",
    });
  }

  if (q.fechaHasta && q.fechaHasta > hoyStr) {
    ctx.addIssue({
      code: "custom",
      path: ["fechaHasta"],
      message: "La fecha final (fechaHasta) no puede ser una fecha futura",
    });
  }

  if (q.fechaDesde && q.fechaHasta && q.fechaDesde > q.fechaHasta) {
    ctx.addIssue({
      code: "custom",
      path: ["fechaDesde"],
      message: "fechaDesde no puede ser posterior a fechaHasta",
    });
  }

  if (q.dia && q.dia > hoyStr) {
    ctx.addIssue({
      code: "custom",
      path: ["dia"],
      message: "El día seleccionado no puede ser una fecha futura",
    });
  }

  if (q.anio && q.anio > hoyMexico.anio) {
    ctx.addIssue({
      code: "custom",
      path: ["anio"],
      message: "El año seleccionado no puede ser un año futuro",
    });
  }

  if (q.mes) {
    const anioEfectivo = q.anio || hoyMexico.anio;
    if (anioEfectivo > hoyMexico.anio || (anioEfectivo === hoyMexico.anio && q.mes > hoyMexico.mes)) {
      ctx.addIssue({
        code: "custom",
        path: ["mes"],
        message: "El mes seleccionado no puede ser un periodo futuro",
      });
    }
  }

  if (q.semana !== undefined) {
    const isoHoy = getIsoYearAndWeek(hoyStr);
    const anioIsoEfectivo = q.anioIso || q.anio || isoHoy.anioIso;

    if (anioIsoEfectivo > isoHoy.anioIso) {
      ctx.addIssue({
        code: "custom",
        path: ["anioIso"],
        message: "El año ISO seleccionado no puede ser futuro",
      });
    } else {
      const maxSemanas = getMaxSemanasIsoEnAnio(anioIsoEfectivo);
      if (q.semana > maxSemanas) {
        ctx.addIssue({
          code: "custom",
          path: ["semana"],
          message: `El año ISO ${anioIsoEfectivo} solo cuenta con ${maxSemanas} semanas ISO`,
        });
      } else {
        const rangoSem = getRangoSemanaIsoUtc(anioIsoEfectivo, q.semana);
        if (rangoSem.fechaInicio > hoyStr) {
          ctx.addIssue({
            code: "custom",
            path: ["semana"],
            message: "La semana seleccionada corresponde a un periodo futuro",
          });
        }
      }
    }
  }

  if (q.periodo === "anio" && !q.anio) {
    ctx.addIssue({
      code: "custom",
      path: ["anio"],
      message: "Debe especificar el parámetro 'anio' cuando el periodo es 'anio'",
    });
  }

  if (q.periodo === "mes" && !q.mes) {
    ctx.addIssue({
      code: "custom",
      path: ["mes"],
      message: "Debe especificar el parámetro 'mes' cuando el periodo es 'mes'",
    });
  }

  if (q.periodo === "semana" && !q.semana) {
    ctx.addIssue({
      code: "custom",
      path: ["semana"],
      message: "Debe especificar el parámetro 'semana' cuando el periodo es 'semana'",
    });
  }

  if (q.periodo === "dia" && !q.dia) {
    ctx.addIssue({
      code: "custom",
      path: ["dia"],
      message: "Debe especificar el parámetro 'dia' cuando el periodo es 'dia'",
    });
  }

  if (q.periodo === "rango" && !q.fechaDesde && !q.fechaHasta) {
    ctx.addIssue({
      code: "custom",
      path: ["fechaDesde"],
      message: "Debe especificar al menos 'fechaDesde' o 'fechaHasta' cuando el periodo es 'rango'",
    });
  }
}

export const getInspeccionesQuerySchema = z
  .object({
    ...filtrosComunesInspeccionesShape,
    page: z.coerce.number().int().positive().max(100000).default(1),
    limit: z.coerce.number().int().positive().max(500).default(30),
  })
  .superRefine(validarReglasTemporalesInspeccion);

export const exportarInspeccionesQuerySchema = z
  .object({
    ...filtrosComunesInspeccionesShape,
  })
  .superRefine(validarReglasTemporalesInspeccion);

export const getPeriodosDisponiblesQuerySchema = z.object({
  anio: z.coerce.number().int().min(2020).max(2100).optional(),
  anioIso: z.coerce.number().int().min(2020).max(2100).optional(),
  mes: z.coerce.number().int().min(1).max(12).optional(),
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
  soloEliminados: z.preprocess((val) => val === "true" || val === true, z.boolean()).optional(),
});

export const getInspectoresQuerySchema = z.object({
  departamentoId: z.coerce.number().int().positive().optional(),
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

export const syncOfflineItemSchema = z.object({
  idLocalCliente: idempotencyKeySchema,
  inspectorId: z.number().int().positive("El ID del inspector debe ser válido"),
  offlineToken: z.string().trim().min(10, "El token offline es obligatorio"),
  fechaCapturaDispositivo: z.string().trim().min(1, "La fecha de captura del dispositivo es obligatoria"),
  esContingencia: z.boolean().optional().default(false),
  motivoContingencia: z.string().trim().max(255).optional().nullable(),
  payload: createInspeccionSchema,
});

export const syncOfflineBatchSchema = z.object({
  items: z
    .array(syncOfflineItemSchema)
    .min(1, "Debe incluir al menos una captura para sincronizar")
    .max(50, "Máximo 50 capturas por lote de sincronización"),
});

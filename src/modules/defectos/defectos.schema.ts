import { z } from "zod";

export const defectoIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, "El ID debe ser un número entero positivo"),
});

export const getDefectosQuerySchema = z.object({
  clave: z.string().regex(/^\d+$/).transform(Number).optional(),
  texto: z.string().trim().optional(),
  busqueda: z.string().trim().optional(),
  clasificacion: z.enum(["CRITICO", "MAYOR", "MENOR"]).optional(),
  departamentoId: z.string().regex(/^\d+$/).transform(Number).optional(),
  etapaId: z.string().regex(/^\d+$/).transform(Number).optional(),
  categoriaDepartamentoId: z.string().regex(/^\d+$/).transform(Number).optional(),
  lineaId: z.string().regex(/^\d+$/).transform(Number).optional(),
  lineasIds: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((val) => {
      if (!val) return undefined;
      const arr = Array.isArray(val) ? val : val.split(",");
      return arr.map((v) => Number(v.trim())).filter((n) => !isNaN(n) && n > 0);
    }),
  activo: z
    .string()
    .transform((val) => val === "true")
    .optional(),
  incluirEliminados: z
    .string()
    .transform((val) => val === "true")
    .optional(),
  soloEliminados: z
    .string()
    .transform((val) => val === "true")
    .optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).optional(),
  page: z.string().regex(/^\d+$/).transform(Number).optional(),
});

export const createDefectoSchema = z.object({
  defecto: z
    .string()
    .min(1, "La descripción del defecto es obligatoria")
    .max(255, "La descripción no debe exceder 255 caracteres")
    .refine((val) => val.trim().length > 0, "La descripción no puede contener solo espacios"),
  clasificacion: z.enum(["CRITICO", "MAYOR", "MENOR"], {
    errorMap: () => ({ message: "La clasificación debe ser CRITICO, MAYOR o MENOR" }),
  }),
  departamentoId: z.number().int().positive("El departamento propietario es obligatorio"),
  departamentosIds: z.array(z.number().int().positive()).optional(),
  etapasPermitidasIds: z.array(z.number().int().positive()).optional(),
});

export const updateDefectoSchema = z.object({
  defecto: z
    .string()
    .min(1, "La descripción del defecto no puede estar vacía")
    .max(255, "La descripción no debe exceder 255 caracteres")
    .refine((val) => val.trim().length > 0, "La descripción no puede contener solo espacios")
    .optional(),
  clasificacion: z.enum(["CRITICO", "MAYOR", "MENOR"]).optional(),
  departamentoId: z.number().int().positive().optional(),
});

export const syncDefectoEtapasSchema = z.object({
  etapas: z.array(
    z.object({
      departamentoId: z.number().int().positive("El departamento de etapa debe ser un ID positivo"),
      permitido: z.boolean({ required_error: "El estado permitido es obligatorio" }),
    })
  ).min(1, "Debe enviar al menos una etapa para actualizar la matriz"),
});

export const updateClaveDefectoSchema = z.object({
  nuevaClave: z.number().int().positive("La nueva clave debe ser un número entero positivo"),
  motivo: z
    .string()
    .min(5, "Se requiere justificación o motivo administrativo (mínimo 5 caracteres)")
    .max(255),
});

export const updateEstadoDefectoSchema = z.object({
  activo: z.boolean({ required_error: "El campo activo es obligatorio" }),
});

export const syncDefectoDepartamentosSchema = z.object({
  departamentos: z.array(
    z.object({
      departamentoId: z.number().int().positive(),
      activo: z.boolean(),
    })
  ),
});

export const toggleDefectoDepartamentoSchema = z.object({
  activo: z.boolean({ required_error: "El campo activo es obligatorio" }),
});

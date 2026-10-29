import { z } from "zod";

export const getLoteByCodigoParamSchema = z.object({
  lote: z.string().trim().min(1, "El número de lote es obligatorio"),
});

export const searchLotesQuerySchema = z.object({
  busqueda: z.string().trim().optional(),
  lista: z.string().trim().optional(),
  modelo: z.string().trim().optional(),
  cliente: z.string().trim().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const catalogoOfflineQuerySchema = z.object({
  desde: z.string().datetime({ offset: true }).optional().or(z.string().datetime().optional()),
  cursor: z.coerce.number().int().nonnegative().optional().default(0),
  limit: z.coerce.number().int().positive().max(1000).optional().default(500),
});


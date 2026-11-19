import { z } from 'zod';

export const runLotesSyncBodySchema = z.object({
  permitirInactivacion: z.boolean().optional(),
  batchSize: z.number().int().positive().max(1000).optional(),
  dryRun: z.boolean().optional().default(false),
  confirmarReconciliacion: z.boolean().optional().default(false),
});

export const getLotesSyncHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  estado: z.enum(['EN_PROCESO', 'EXITOSO', 'FALLIDO', 'PREVISUALIZACION']).optional(),
});

export type RunLotesSyncBody = z.infer<typeof runLotesSyncBodySchema>;
export type GetLotesSyncHistoryQuery = z.infer<typeof getLotesSyncHistoryQuerySchema>;

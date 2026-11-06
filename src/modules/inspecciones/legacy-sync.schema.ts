import { z } from 'zod';
import { ARCHIVOS_PRODUCCION_LEGACY } from './services/legacy-incremental-sync.service';

const VALID_LEGACY_FILES = new Set(ARCHIVOS_PRODUCCION_LEGACY.map(c => c.archivo));

export const runLegacySyncBodySchema = z
  .object({
    archivo: z
      .string()
      .trim()
      .refine(val => VALID_LEGACY_FILES.has(val), {
        message: 'Nombre de archivo TXT legacy inválido o no permitido',
      })
      .optional(),
    archivos: z
      .array(
        z
          .string()
          .trim()
          .refine(val => VALID_LEGACY_FILES.has(val), {
            message: 'Nombre de archivo TXT legacy inválido o no permitido',
          })
      )
      .min(1, 'Si especifica la lista de archivos, debe incluir al menos uno')
      .optional(),
  })
  .strict()
  .optional();

export const getLegacySyncHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  archivo: z
    .string()
    .trim()
    .refine(val => VALID_LEGACY_FILES.has(val), {
      message: 'Nombre de archivo TXT legacy inválido',
    })
    .optional(),
  departamento: z.string().trim().min(1).max(40).optional(),
  estado: z.enum(['EN_PROCESO', 'EXITOSO', 'FALLIDO']).optional(),
});

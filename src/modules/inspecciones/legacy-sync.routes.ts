import { Router } from 'express';
import { authenticate, requirePermission, requireRole } from '../../middlewares/auth';
import { validate } from '../../middlewares/validate';
import { legacySyncController } from './legacy-sync.controller';
import {
  getLegacySyncHistoryQuerySchema,
  runLegacySyncBodySchema,
} from './legacy-sync.schema';

const router = Router();

// Todas las rutas administrativas de sincronización Legacy exigen sesión activa y rol administrativo
router.use(authenticate);
router.use(requireRole(['SUPER_ADMIN', 'ADMIN']));

// GET /api/v1/admin/legacy-sync/status
router.get(
  '/status',
  requirePermission('sincronizacion.consultar'),
  (req, res, next) => legacySyncController.getStatus(req, res, next)
);

// POST /api/v1/admin/legacy-sync/run
router.post(
  '/run',
  requirePermission('sincronizacion.gestionar'),
  validate({ body: runLegacySyncBodySchema }),
  (req, res, next) => legacySyncController.runSync(req, res, next)
);

// GET /api/v1/admin/legacy-sync/history
router.get(
  '/history',
  requirePermission('sincronizacion.consultar'),
  validate({ query: getLegacySyncHistoryQuerySchema }),
  (req, res, next) => legacySyncController.getHistory(req, res, next)
);

export const legacySyncAdminRouter = router;

import { Router } from 'express';
import { authenticate, requirePermission, requireRole } from '../../middlewares/auth';
import { validate } from '../../middlewares/validate';
import { lotesSyncController } from './lotes-sync.controller';
import {
  getLotesSyncHistoryQuerySchema,
  runLotesSyncBodySchema,
} from './lotes-sync.schema';

const router = Router();

// Todas las rutas de administración de lotes exigen sesión activa y rol administrativo
router.use(authenticate);
router.use(requireRole(['SUPER_ADMIN', 'ADMIN']));

// GET /api/v1/admin/lotes-sync/status
router.get(
  '/status',
  requirePermission('sincronizacion.consultar'),
  (req, res, next) => lotesSyncController.getStatus(req, res, next)
);

// POST /api/v1/admin/lotes-sync/run
router.post(
  '/run',
  requirePermission('sincronizacion.gestionar'),
  validate({ body: runLotesSyncBodySchema }),
  (req, res, next) => lotesSyncController.runSync(req, res, next)
);

// GET /api/v1/admin/lotes-sync/history
router.get(
  '/history',
  requirePermission('sincronizacion.consultar'),
  validate({ query: getLotesSyncHistoryQuerySchema }),
  (req, res, next) => lotesSyncController.getHistory(req, res, next)
);

export const lotesSyncAdminRouter = router;

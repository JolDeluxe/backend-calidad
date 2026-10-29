import { Router } from "express";
import { inspeccionesController } from "./inspecciones.controller";
import {
  authenticate,
  requireRole,
  requirePermission,
  requireTerminal,
} from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import {
  createInspeccionSchema,
  getInspeccionesQuerySchema,
  eliminacionLogicaSchema,
  detalleIdParamSchema,
  inspeccionIdParamSchema,
  detalleIncluirQuerySchema,
  syncOfflineBatchSchema,
} from "./inspecciones.schema";
import { resolverAlcanceHistorial, requireAlcanceGeneral } from "./inspecciones.access";

const router = Router();

/**
 * Sincronización diferida e idempotente de capturas offline por lote.
 * - Exige terminal física vinculada y activa (`requireTerminal`).
 * - Cada elemento del lote porta su propio `offlineToken` firmado con HMAC-SHA256
 *   por el servidor para el inspector que realizó la captura, permitiendo drenar
 *   la cola aunque en la PC haya iniciado sesión otro inspector o ninguno.
 */
router.post(
  "/sync",
  requireTerminal,
  validate({ body: syncOfflineBatchSchema }),
  (req, res, next) => inspeccionesController.syncOfflineBatch(req, res, next),
);

router.use(authenticate);

// Métricas agregadas del Dashboard de inicio (Top 10 semanal y contadores hoy para todos los usuarios)
router.get("/dashboard-metricas", (req, res, next) =>
  inspeccionesController.getDashboardMetricas(req, res, next)
);

// Registrar nueva inspección de defectos:
// 1. Debe estar autenticado (authenticate a nivel de router).
// 2. Exclusivo para rol INSPECTOR: Se bloquea explícitamente a SUPER_ADMIN, ADMIN y COORD.
// 3. Exige terminal física vinculada y activa mediante requireTerminal.
// 4. Exige permiso granular defectos.capturar.
// 5. Valida el cuerpo de la petición. Soporta encabezado opcional Idempotency-Key.
router.post(
  "/",
  requireRole(["INSPECTOR"]),
  requireTerminal,
  requirePermission("defectos.capturar"),
  validate({ body: createInspeccionSchema }),
  (req, res, next) => inspeccionesController.createInspeccion(req, res, next)
);

// Listado de inspectores registrados (catálogo para filtros): solo alcance general
router.get(
  "/inspectores",
  resolverAlcanceHistorial,
  requireAlcanceGeneral,
  (req, res, next) => inspeccionesController.getInspectores(req, res, next)
);

// Historial: filas por defecto registrado. Alcance según permisos efectivos (propios / general).
router.get(
  "/",
  validate({ query: getInspeccionesQuerySchema }),
  resolverAlcanceHistorial,
  (req, res, next) => inspeccionesController.getFilasInspeccion(req, res, next)
);

// Detalle completo de una inspección (cabecera + defectos + trazabilidad si hay permiso de auditoría)
router.get(
  "/:id",
  validate({ params: inspeccionIdParamSchema, query: detalleIncluirQuerySchema }),
  resolverAlcanceHistorial,
  (req, res, next) => inspeccionesController.getDetalle(req, res, next)
);

// Eliminación lógica de un defecto registrado: permiso explícito + motivo obligatorio
router.post(
  "/detalles/:id/cancelar",
  requirePermission("defectos.eliminar"),
  validate({ params: detalleIdParamSchema, body: eliminacionLogicaSchema }),
  (req, res, next) => inspeccionesController.cancelarDetalle(req, res, next)
);

// Recuperación de un defecto eliminado lógicamente: permiso explícito + motivo obligatorio
router.post(
  "/detalles/:id/recuperar",
  requirePermission("defectos.eliminar"),
  validate({ params: detalleIdParamSchema, body: eliminacionLogicaSchema }),
  (req, res, next) => inspeccionesController.recuperarDetalle(req, res, next)
);

export const inspeccionesRouter = router;

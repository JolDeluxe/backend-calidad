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
} from "./inspecciones.schema";
import { resolverAlcanceHistorial, requireAlcanceGeneral } from "./inspecciones.access";

const router = Router();

router.use(authenticate);

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

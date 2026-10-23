import { Router } from "express";
import { tiposOperacionController } from "./controllers/tipos-operacion.controller";
import { authenticate, requireRole } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import {
  tipoOperacionIdParamSchema,
  createTipoOperacionSchema,
  updateTipoOperacionSchema,
  updateEstadoTipoOperacionSchema,
  lineaIdParamSchema,
  createLineaSchema,
  updateLineaSchema,
  updateEstadoLineaSchema,
  syncLineaDepartamentosSchema,
} from "./tipos-operacion.schema";

const router = Router();

router.use(authenticate);

// Tipos de Operación
router.get("/", (req, res, next) => tiposOperacionController.getTiposOperacion(req, res, next));

router.get(
  "/:id",
  validate({ params: tipoOperacionIdParamSchema }),
  (req, res, next) => tiposOperacionController.getTipoOperacionById(req, res, next)
);

router.post(
  "/",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ body: createTipoOperacionSchema }),
  (req, res, next) => tiposOperacionController.createTipoOperacion(req, res, next)
);

router.patch(
  "/:id",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: tipoOperacionIdParamSchema, body: updateTipoOperacionSchema }),
  (req, res, next) => tiposOperacionController.updateTipoOperacion(req, res, next)
);

router.patch(
  "/:id/estado",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: tipoOperacionIdParamSchema, body: updateEstadoTipoOperacionSchema }),
  (req, res, next) => tiposOperacionController.updateEstadoTipoOperacion(req, res, next)
);

router.delete(
  "/:id",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: tipoOperacionIdParamSchema }),
  (req, res, next) => tiposOperacionController.deleteTipoOperacion(req, res, next)
);

export const tiposOperacionRouter = router;

// Sub-router para Líneas
const lineasRouter = Router();
lineasRouter.use(authenticate);

lineasRouter.get("/", (req, res, next) => tiposOperacionController.getLineas(req, res, next));

lineasRouter.get(
  "/:id",
  validate({ params: lineaIdParamSchema }),
  (req, res, next) => tiposOperacionController.getLineaById(req, res, next)
);

lineasRouter.post(
  "/",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ body: createLineaSchema }),
  (req, res, next) => tiposOperacionController.createLinea(req, res, next)
);

lineasRouter.patch(
  "/:id",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: lineaIdParamSchema, body: updateLineaSchema }),
  (req, res, next) => tiposOperacionController.updateLinea(req, res, next)
);

lineasRouter.patch(
  "/:id/estado",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: lineaIdParamSchema, body: updateEstadoLineaSchema }),
  (req, res, next) => tiposOperacionController.updateEstadoLinea(req, res, next)
);

lineasRouter.delete(
  "/:id",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: lineaIdParamSchema }),
  (req, res, next) => tiposOperacionController.deleteLinea(req, res, next)
);

lineasRouter.put(
  "/:id/departamentos",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: lineaIdParamSchema, body: syncLineaDepartamentosSchema }),
  (req, res, next) => tiposOperacionController.syncLineaDepartamentos(req, res, next)
);

export { lineasRouter };

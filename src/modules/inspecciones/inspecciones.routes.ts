import { Router } from "express";
import { inspeccionesController } from "./inspecciones.controller";
import { authenticate, requirePermission } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import {
  createInspeccionSchema,
  getInspeccionesQuerySchema,
} from "./inspecciones.schema";

const router = Router();

router.use(authenticate);

// Registrar nueva inspección de defectos (Exige permiso granular defectos.capturar)
router.post(
  "/",
  requirePermission("defectos.capturar"),
  validate({ body: createInspeccionSchema }),
  (req, res, next) => inspeccionesController.createInspeccion(req, res, next)
);

// Consultar filas de inspecciones (HOY, ULTIMOS, TODOS + Mes/Año + Búsqueda por Lote/Defecto)
router.get(
  "/",
  validate({ query: getInspeccionesQuerySchema }),
  (req, res, next) => inspeccionesController.getFilasInspeccion(req, res, next)
);

export const inspeccionesRouter = router;

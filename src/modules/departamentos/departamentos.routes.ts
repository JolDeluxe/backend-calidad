import { Router } from "express";
import { departamentosController } from "./controllers/departamentos.controller";
import { authenticate, requireRole } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import {
  departamentoIdParamSchema,
  getDepartamentosQuerySchema,
  createDepartamentoSchema,
  updateDepartamentoSchema,
  updateEstadoDepartamentoSchema,
  syncDepartamentoLineasSchema,
} from "./departamentos.schema";

const router = Router();

router.use(authenticate);

router.get(
  "/",
  validate({ query: getDepartamentosQuerySchema }),
  (req, res, next) => departamentosController.getDepartamentos(req, res, next)
);

router.get(
  "/:id",
  validate({ params: departamentoIdParamSchema }),
  (req, res, next) => departamentosController.getDepartamentoById(req, res, next)
);

router.post(
  "/",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ body: createDepartamentoSchema }),
  (req, res, next) => departamentosController.createDepartamento(req, res, next)
);

router.patch(
  "/:id",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: departamentoIdParamSchema, body: updateDepartamentoSchema }),
  (req, res, next) => departamentosController.updateDepartamento(req, res, next)
);

router.patch(
  "/:id/estado",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: departamentoIdParamSchema, body: updateEstadoDepartamentoSchema }),
  (req, res, next) => departamentosController.updateEstadoDepartamento(req, res, next)
);

router.delete(
  "/:id",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: departamentoIdParamSchema }),
  (req, res, next) => departamentosController.deleteDepartamento(req, res, next)
);

router.put(
  "/:id/lineas",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: departamentoIdParamSchema, body: syncDepartamentoLineasSchema }),
  (req, res, next) => departamentosController.syncDepartamentoLineas(req, res, next)
);

export const departamentosRouter = router;

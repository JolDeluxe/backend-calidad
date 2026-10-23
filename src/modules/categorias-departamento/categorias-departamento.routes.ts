import { Router } from "express";
import { categoriasDepartamentoController } from "./controllers/categorias-departamento.controller";
import { authenticate, requireRole } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import {
  categoriaDepartamentoIdParamSchema,
  getCategoriasDepartamentoQuerySchema,
  createCategoriaDepartamentoSchema,
  updateCategoriaDepartamentoSchema,
  updateEstadoCategoriaDepartamentoSchema,
} from "./categorias-departamento.schema";

const router = Router();

router.use(authenticate);

router.get(
  "/",
  validate({ query: getCategoriasDepartamentoQuerySchema }),
  (req, res, next) => categoriasDepartamentoController.getCategorias(req, res, next)
);

router.get(
  "/:id",
  validate({ params: categoriaDepartamentoIdParamSchema }),
  (req, res, next) => categoriasDepartamentoController.getCategoriaById(req, res, next)
);

router.post(
  "/",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ body: createCategoriaDepartamentoSchema }),
  (req, res, next) => categoriasDepartamentoController.createCategoria(req, res, next)
);

router.patch(
  "/:id",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({
    params: categoriaDepartamentoIdParamSchema,
    body: updateCategoriaDepartamentoSchema,
  }),
  (req, res, next) => categoriasDepartamentoController.updateCategoria(req, res, next)
);

router.patch(
  "/:id/estado",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({
    params: categoriaDepartamentoIdParamSchema,
    body: updateEstadoCategoriaDepartamentoSchema,
  }),
  (req, res, next) => categoriasDepartamentoController.updateEstado(req, res, next)
);

router.delete(
  "/:id",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: categoriaDepartamentoIdParamSchema }),
  (req, res, next) => categoriasDepartamentoController.deleteCategoria(req, res, next)
);

export const categoriasDepartamentoRouter = router;

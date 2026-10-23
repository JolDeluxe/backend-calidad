import { Router } from "express";
import { lotesController } from "./lotes.controller";
import { authenticate } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import { getLoteByCodigoParamSchema, searchLotesQuerySchema } from "./lotes.schema";

const router = Router();

router.use(authenticate);

// Búsqueda y listado paginado de lotes
router.get(
  "/",
  validate({ query: searchLotesQuerySchema }),
  (req, res, next) => lotesController.searchLotes(req, res, next)
);

// Consulta individual por código de lote
router.get(
  "/:lote",
  validate({ params: getLoteByCodigoParamSchema }),
  (req, res, next) => lotesController.getByCodigo(req, res, next)
);

export const lotesRouter = router;

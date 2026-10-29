import { Router } from "express";
import { lotesController } from "./lotes.controller";
import { authenticate, authenticateOrTerminal, requireTerminal } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import {
  getLoteByCodigoParamSchema,
  searchLotesQuerySchema,
  catalogoOfflineQuerySchema,
} from "./lotes.schema";
import { lotesCatalogoOfflineService } from "./services/lotes-catalogo-offline.service";
import { sendSuccess } from "../../utils/response";

const router = Router();

/**
 * Descarga inicial y sincronización diferencial de lotes para IndexedDB (Modo Offline).
 * Paginación determinista keyset (cursor por ID) y soporte de marca temporal 'desde'.
 * Protegido por validación de terminal física (y opcionalmente sesión de usuario).
 */
router.get(
  "/catalogo-offline",
  authenticateOrTerminal,
  requireTerminal,
  validate({ query: catalogoOfflineQuerySchema }),
  async (req, res, next) => {
    try {
      const desdeStr = req.query.desde as string | undefined;
      const cursor = req.query.cursor ? Number(req.query.cursor) : 0;
      const limit = req.query.limit ? Number(req.query.limit) : 500;

      const resultado = await lotesCatalogoOfflineService.getCatalogoOffline({
        desde: desdeStr ? new Date(desdeStr) : undefined,
        cursor,
        limit,
      });

      sendSuccess(res, resultado, "Catálogo de lotes para modo offline recuperado");
    } catch (error) {
      next(error);
    }
  },
);

router.use(authenticate);

// Búsqueda y listado paginado de lotes
router.get(
  "/",
  validate({ query: searchLotesQuerySchema }),
  (req, res, next) => lotesController.searchLotes(req, res, next),
);

// Consulta individual por código de lote
router.get(
  "/:lote",
  validate({ params: getLoteByCodigoParamSchema }),
  (req, res, next) => lotesController.getByCodigo(req, res, next),
);

export const lotesRouter = router;

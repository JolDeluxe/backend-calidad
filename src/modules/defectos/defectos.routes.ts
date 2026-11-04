import { Router } from "express";
import { defectosController } from "./controllers/defectos.controller";
import { authenticate, authenticateOrTerminal, requireRole } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import {
  defectoIdParamSchema,
  getDefectosQuerySchema,
  validarDefectoCapturaQuerySchema,
  createDefectoSchema,
  updateDefectoSchema,
  updateClaveDefectoSchema,
  updateEstadoDefectoSchema,
  syncDefectoDepartamentosSchema,
  toggleDefectoDepartamentoSchema,
  syncDefectoEtapasSchema,
  getGruposCodificacionQuerySchema,
  previewLoteDefectosSchema,
  crearLoteDefectosSchema,
  upsertReglaVisibilidadSchema,
  updateMatrizDepartamentoSchema,
  resolverVisibilidadQuerySchema,
} from "./defectos.schema";

const router = Router();

router.get(
  "/",
  authenticateOrTerminal,
  validate({ query: getDefectosQuerySchema }),
  (req, res, next) => defectosController.getDefectos(req, res, next)
);

router.get(
  "/validar-captura",
  authenticateOrTerminal,
  validate({ query: validarDefectoCapturaQuerySchema }),
  (req, res, next) => defectosController.validarDefectoCaptura(req, res, next)
);

router.get(
  "/matriz-visibilidad",
  authenticateOrTerminal,
  requireRole(["SUPER_ADMIN", "ADMIN", "VISUALIZADOR", "INSPECTOR"]),
  (req, res, next) => defectosController.getMatrizVisibilidad(req, res, next)
);

router.use(authenticate);

router.get(
  "/conteos-lineas",
  (req, res, next) => defectosController.getConteoLineas(req, res, next)
);

router.get(
  "/grupos-codificacion",
  validate({ query: getGruposCodificacionQuerySchema }),
  (req, res, next) => defectosController.getGruposCodificacion(req, res, next)
);

router.get(
  "/matriz-visibilidad/:departamentoOrigenId",
  requireRole(["SUPER_ADMIN", "ADMIN", "VISUALIZADOR"]),
  (req, res, next) => defectosController.getMatrizVisibilidadPorDepartamento(req, res, next)
);

router.post(
  "/matriz-visibilidad/regla",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ body: upsertReglaVisibilidadSchema }),
  (req, res, next) => defectosController.upsertReglaVisibilidad(req, res, next)
);

router.put(
  "/matriz-visibilidad/departamento",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ body: updateMatrizDepartamentoSchema }),
  (req, res, next) => defectosController.actualizarMatrizDepartamento(req, res, next)
);

router.get(
  "/resolver-visibilidad",
  validate({ query: resolverVisibilidadQuerySchema }),
  (req, res, next) => defectosController.resolverVisibilidad(req, res, next)
);

router.post(
  "/batch/preview",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ body: previewLoteDefectosSchema }),
  (req, res, next) => defectosController.previsualizarLote(req, res, next)
);

router.post(
  "/batch",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ body: crearLoteDefectosSchema }),
  (req, res, next) => defectosController.crearLote(req, res, next)
);

router.get(
  "/:id",
  validate({ params: defectoIdParamSchema }),
  (req, res, next) => defectosController.getDefectoById(req, res, next)
);

router.post(
  "/",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ body: createDefectoSchema }),
  (req, res, next) => defectosController.createDefecto(req, res, next)
);

router.patch(
  "/:id",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: defectoIdParamSchema, body: updateDefectoSchema }),
  (req, res, next) => defectosController.updateDefecto(req, res, next)
);

router.patch(
  "/:id/clave",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: defectoIdParamSchema, body: updateClaveDefectoSchema }),
  (req, res, next) => defectosController.updateClaveDefecto(req, res, next)
);

router.patch(
  "/:id/estado",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: defectoIdParamSchema, body: updateEstadoDefectoSchema }),
  (req, res, next) => defectosController.updateEstadoDefecto(req, res, next)
);

router.delete(
  "/:id",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: defectoIdParamSchema }),
  (req, res, next) => defectosController.deleteDefecto(req, res, next)
);

router.post(
  "/:id/reactivar",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: defectoIdParamSchema }),
  (req, res, next) => defectosController.reactivarDefecto(req, res, next)
);

router.put(
  "/:id/departamentos",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: defectoIdParamSchema, body: syncDefectoDepartamentosSchema }),
  (req, res, next) => defectosController.syncDefectoDepartamentos(req, res, next)
);

router.patch(
  "/:id/departamentos/:departamentoId",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ body: toggleDefectoDepartamentoSchema }),
  (req, res, next) => defectosController.toggleDefectoDepartamento(req, res, next)
);

router.put(
  "/:id/etapas",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: defectoIdParamSchema, body: syncDefectoEtapasSchema }),
  (req, res, next) => defectosController.syncDefectoEtapas(req, res, next)
);

export const defectosRouter = router;

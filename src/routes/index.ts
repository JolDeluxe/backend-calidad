import { Router } from "express";
import { authRouter } from "../modules/auth/auth.routes";
import { usersRouter } from "../modules/users/users.routes";
import { terminalsRouter } from "../modules/terminals/terminals.routes";
import { auditRouter } from "../modules/audit/audit.routes";
import { tiposOperacionRouter, lineasRouter } from "../modules/tipos-operacion/tipos-operacion.routes";
import { departamentosRouter } from "../modules/departamentos/departamentos.routes";
import { categoriasDepartamentoRouter } from "../modules/categorias-departamento/categorias-departamento.routes";
import { defectosRouter } from "../modules/defectos/defectos.routes";
import { lotesRouter } from "../modules/lotes/lotes.routes";
import { inspeccionesRouter } from "../modules/inspecciones/inspecciones.routes";
import { proyeccionRouter } from "../modules/proyeccion/proyeccion.routes";

const router = Router();

router.use("/auth", authRouter);
router.use("/users", usersRouter);
router.use("/terminals", terminalsRouter);
router.use("/terminales", terminalsRouter);
router.use("/audit", auditRouter);
router.use("/tipos-operacion", tiposOperacionRouter);
router.use("/lineas", lineasRouter);
router.use("/departamentos", departamentosRouter);
router.use("/categorias-departamento", categoriasDepartamentoRouter);
router.use("/defectos", defectosRouter);
router.use("/lotes", lotesRouter);
router.use("/inspecciones", inspeccionesRouter);
router.use("/proyeccion", proyeccionRouter);

export const v1Router = router;

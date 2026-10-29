import { Router } from "express";
import { proyeccionController } from "./proyeccion.controller";
import { authenticate } from "../../middlewares/auth";

const router = Router();

// Ambos endpoints admiten consulta autenticada para despliegue en Kioscos autorizados
router.get("/resumen-general", authenticate, proyeccionController.getResumenGeneral);
router.get("/reporte-semanal", authenticate, proyeccionController.getReporteSemanal);

export const proyeccionRouter = router;

import { Router } from "express";
import { auditController } from "./audit.controller";
import { authenticate, requireRole } from "../../middlewares/auth";

const router = Router();

// Todas las rutas de auditoría, logs y monitoreo requieren sesión activa y rol administrativo
router.use(authenticate);
router.use(requireRole(["SUPER_ADMIN", "ADMIN"]));

// 1. Auditoría Funcional e Integridad Criptográfica
router.get("/events", (req, res, next) => auditController.getEvents(req, res, next));
router.get("/integrity", (req, res, next) => auditController.verifyIntegrity(req, res, next));

// 2. Logs Técnicos y PM2
router.get("/logs/technical", (req, res, next) => auditController.getTechnicalLogs(req, res, next));
router.get("/logs/pm2-files", (req, res, next) => auditController.getPm2LogFiles(req, res, next));
router.get("/logs/pm2-content", (req, res, next) => auditController.getPm2LogContent(req, res, next));

// 3. Monitoreo de Salud y Diagnóstico para IA
router.get("/health", (req, res, next) => auditController.getHealth(req, res, next));
router.post("/diagnostics/ai", (req, res, next) => auditController.generateAiDiagnostics(req, res, next));

export const auditRouter = router;

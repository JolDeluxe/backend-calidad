import type { Request, Response, NextFunction } from "express";
import { auditService } from "./services/audit.service";
import { pm2LogsReaderService } from "./services/pm2-logs-reader.service";
import { aiDiagnosticsService } from "./services/ai-diagnostics.service";
import { technicalLogger, type LogLevel } from "../../utils/technical-logger";
import { sendSuccess } from "../../utils/response";
import { BadRequestError } from "../../utils/errors";
import { prisma } from "../../config/database";
import type { RequestWithTracking } from "../../middlewares/correlation";

export class AuditController {
  /**
   * GET /api/v1/audit/events
   * Consulta paginada y filtrada del registro de auditoría funcional.
   */
  async getEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const accion = req.query.accion as string | undefined;
      const usuarioId = req.query.usuarioId ? parseInt(req.query.usuarioId as string, 10) : undefined;
      const entidad = req.query.entidad as string | undefined;
      const entidadId = req.query.entidadId as string | undefined;
      const departamentoId = req.query.departamentoId ? parseInt(req.query.departamentoId as string, 10) : undefined;
      const terminalId = req.query.terminalId ? parseInt(req.query.terminalId as string, 10) : undefined;
      const resultado = req.query.resultado as string | undefined;
      const fechaDesde = req.query.fechaDesde ? new Date(req.query.fechaDesde as string) : undefined;
      const fechaHasta = req.query.fechaHasta ? new Date(req.query.fechaHasta as string) : undefined;

      const resultadoConsulta = await auditService.consultarEventos({
        page,
        limit,
        accion,
        usuarioId,
        entidad,
        entidadId,
        departamentoId,
        terminalId,
        resultado,
        fechaDesde,
        fechaHasta,
      });

      sendSuccess(res, resultadoConsulta);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/audit/integrity
   * Valida la cadena criptográfica SHA-256 de integridad de auditoría.
   */
  async verifyIntegrity(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const resultado = await auditService.verificarIntegridadCadena();
      sendSuccess(res, resultado);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/audit/logs/technical
   * Consulta streaming/filtrada de logs técnicos del backend (JSON Lines).
   */
  async getTechnicalLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const nivel = req.query.nivel as LogLevel | undefined;
      const texto = req.query.texto as string | undefined;
      const modulo = req.query.modulo as string | undefined;
      const requestId = req.query.requestId as string | undefined;
      const fechaDesde = req.query.fechaDesde as string | undefined;

      const result = await technicalLogger.queryLogs({
        limit,
        page,
        nivel,
        texto,
        modulo,
        requestId,
        fechaDesde,
      });

      sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/audit/logs/pm2-files
   * Lista archivos de log autorizados de PM2 y backend.
   */
  async getPm2LogFiles(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const files = pm2LogsReaderService.getAuthorizedLogFiles();
      sendSuccess(res, { files });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/audit/logs/pm2-content
   * Lee líneas de un archivo de log autorizado de PM2.
   */
  async getPm2LogContent(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const fileName = req.query.fileName as string;
      if (!fileName) {
        throw new BadRequestError("El parámetro 'fileName' es requerido");
      }
      const lines = req.query.lines ? parseInt(req.query.lines as string, 10) : 150;
      const filter = req.query.filter as string | undefined;
      const reverse = req.query.reverse === "true";

      const content = await pm2LogsReaderService.readLogFile(fileName, {
        lineasMaximas: lines,
        filtroTexto: filter,
        invertirOrden: reverse,
      });
      sendSuccess(res, content);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/audit/health
   * Diagnóstico y salud operativa en tiempo real del backend, MySQL y proceso.
   */
  async getHealth(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const dbStart = performance.now();
      let dbOk = false;
      let dbLatencyMs = 0;
      let dbError: string | undefined;

      try {
        await prisma.$queryRaw`SELECT 1 as ping`;
        dbOk = true;
        dbLatencyMs = Math.round((performance.now() - dbStart) * 100) / 100;
      } catch (err) {
        dbError = (err as Error).message;
        dbLatencyMs = Math.round((performance.now() - dbStart) * 100) / 100;
      }

      const mem = process.memoryUsage();

      sendSuccess(res, {
        status: dbOk ? "healthy" : "degraded",
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        database: {
          status: dbOk ? "connected" : "error",
          latencyMs: dbLatencyMs,
          ...(dbError && { error: dbError }),
        },
        memory: {
          rssMb: Math.round(mem.rss / 1024 / 1024),
          heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
        },
        environment: process.env.NODE_ENV || "development",
        platform: process.platform,
        bunVersion: (process as unknown as { isBun?: boolean }).isBun ? "Bun detected" : process.version,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/audit/diagnostics/ai
   * Genera el paquete completo de diagnóstico para IA en formato JSON y Markdown sanitizado.
   */
  async generateAiDiagnostics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { requestId, correlationId, codigoError, ventanaMinutos } = req.body || {};
      const reqWithTracking = req as RequestWithTracking;

      const diagnosticsPackage = await aiDiagnosticsService.buildDiagnosticsPackage({
        requestId: requestId || reqWithTracking.requestId,
        correlationId: correlationId || reqWithTracking.correlationId,
        codigoError,
        ventanaMinutos: ventanaMinutos ? Number(ventanaMinutos) : 15,
      });

      const markdownReport = aiDiagnosticsService.formatDiagnosticsAsMarkdown(diagnosticsPackage);

      sendSuccess(res, {
        package: diagnosticsPackage,
        markdown: markdownReport,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const auditController = new AuditController();

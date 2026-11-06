import type { Request, Response, NextFunction } from 'express';
import { ConflictError } from '../../utils/errors';
import { sendSuccess } from '../../utils/response';
import { legacySyncSchedulerService } from './services/legacy-sync-scheduler.service';

export class LegacySyncController {
  /**
   * GET /api/v1/admin/legacy-sync/status
   * Informa el estado actual del sincronizador, última ejecución, próxima ejecución programada,
   * métricas acumuladas y configuración de departamentos WEB / LEGACY.
   */
  async getStatus(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const status = await legacySyncSchedulerService.getDetailedStatus();
      sendSuccess(res, status);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/admin/legacy-sync/run
   * Inicia una ejecución manual controlada en segundo plano (general o por archivo),
   * responde de inmediato con 202 Accepted y el identificador de ejecución (`cycleId`),
   * o rechaza con 409 Conflict si ya existe una sincronización activa.
   */
  async runSync(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = (req.body || {}) as {
        archivo?: string;
        archivos?: string[];
      };

      let archivosFiltro: string[] | undefined;
      if (body.archivos && body.archivos.length > 0) {
        archivosFiltro = Array.from(new Set(body.archivos));
      } else if (body.archivo) {
        archivosFiltro = [body.archivo];
      }

      const ticket = await legacySyncSchedulerService.startAsyncManualRun({
        archivosFiltro,
      });

      if (!ticket.accepted) {
        throw new ConflictError(
          `No se puede iniciar la sincronización: ya existe una ejecución en curso o el servidor está apagándose (${ticket.skipReason}).`
        );
      }

      sendSuccess(
        res,
        {
          cycleId: ticket.cycleId,
          ownerUuid: ticket.ownerUuid,
          trigger: ticket.trigger,
          iniciadoEn: ticket.startedAt,
          archivosObjetivo: ticket.targetFiles,
          estado: 'EN_PROCESO',
        },
        'Sincronización incremental Legacy iniciada en segundo plano.',
        202
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/admin/legacy-sync/history
   * Consulta paginada de los registros de auditoría de sincronización (`control_sincronizaciones_legacy`).
   */
  async getHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = req.query as unknown as {
        page?: number;
        limit?: number;
        archivo?: string;
        departamento?: string;
        estado?: 'EN_PROCESO' | 'EXITOSO' | 'FALLIDO';
      };

      const history = await legacySyncSchedulerService.getExecutionHistory({
        page: query.page,
        limit: query.limit,
        archivo: query.archivo,
        departamento: query.departamento,
        estado: query.estado,
      });

      sendSuccess(res, history);
    } catch (error) {
      next(error);
    }
  }
}

export const legacySyncController = new LegacySyncController();

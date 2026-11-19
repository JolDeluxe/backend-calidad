import type { Request, Response, NextFunction } from 'express';
import { ConflictError } from '../../utils/errors';
import { sendSuccess } from '../../utils/response';
import { lotesSyncSchedulerService } from './services/lotes-sync-scheduler.service';
import type { RunLotesSyncBody, GetLotesSyncHistoryQuery } from './lotes-sync.schema';

export class LotesSyncController {
  /**
   * GET /api/v1/admin/lotes-sync/status
   * Informa el estado actual del scheduler de lotes, última ejecución, próxima ejecución programada (06:00 AM)
   * y reintentos pendientes.
   */
  async getStatus(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const status = await lotesSyncSchedulerService.getDetailedStatus();
      sendSuccess(res, status);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/admin/lotes-sync/run
   * Inicia una ejecución manual de importación de lotes en segundo plano,
   * responde de inmediato con 202 Accepted o 409 Conflict si ya hay una ejecución en curso.
   */
  async runSync(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = (req.body || {}) as RunLotesSyncBody;

      const ticket = await lotesSyncSchedulerService.startAsyncManualRun({
        permitirInactivacion: body.permitirInactivacion,
        batchSize: body.batchSize,
        usuarioId: (req as any).user?.id,
      });

      if (!ticket.accepted) {
        throw new ConflictError(
          `No se puede iniciar la sincronización de lotes: ya existe una ejecución en curso o el servidor está apagándose (${ticket.skipReason}).`
        );
      }

      sendSuccess(
        res,
        {
          cycleId: ticket.cycleId,
          ownerUuid: ticket.ownerUuid,
          trigger: ticket.trigger,
          iniciadoEn: ticket.startedAt,
          estado: 'EN_PROCESO',
        },
        'Actualización del catálogo de lotes iniciada en segundo plano.',
        202
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/admin/lotes-sync/history
   * Consulta paginada del historial de auditoría de sincronizaciones de lotes.
   */
  async getHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = req.query as unknown as GetLotesSyncHistoryQuery;

      const history = await lotesSyncSchedulerService.getExecutionHistory({
        page: query.page,
        limit: query.limit,
        estado: query.estado,
      });

      sendSuccess(res, history);
    } catch (error) {
      next(error);
    }
  }
}

export const lotesSyncController = new LotesSyncController();

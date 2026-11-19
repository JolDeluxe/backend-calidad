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
   * Inicia una ejecución de reconciliación de lotes.
   * Si dryRun es true, ejecuta la previsualización y responde directamente con el desglose estimado.
   * Si es reconciliación real, inicia en segundo plano con ticket 202 Accepted.
   */
  async runSync(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = (req.body || {}) as RunLotesSyncBody;

      const ticket = await lotesSyncSchedulerService.startAsyncManualRun({
        permitirInactivacion: body.permitirInactivacion,
        batchSize: body.batchSize,
        dryRun: body.dryRun,
        confirmarReconciliacion: body.confirmarReconciliacion,
        usuarioId: (req as any).user?.id,
      });

      if (!ticket.accepted) {
        throw new ConflictError(
          `No se puede iniciar la sincronización de lotes: ya existe una ejecución en curso o el servidor está apagándose (${ticket.skipReason}).`
        );
      }

      if (body.dryRun && ticket.completionPromise) {
        const cycleOutcome = await ticket.completionPromise;
        sendSuccess(
          res,
          {
            cycleId: ticket.cycleId,
            dryRun: true,
            iniciadoEn: ticket.startedAt,
            finalizadoEn: cycleOutcome.finishedAt,
            resultado: cycleOutcome.result,
          },
          'Previsualización de reconciliación completada exitosamente (sin mutar base de datos).'
        );
        return;
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

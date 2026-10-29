import type { Request, Response, NextFunction } from "express";
import { inspeccionesService } from "./services/inspecciones.service";
import { sendSuccess, sendCreated } from "../../utils/response";
import { ForbiddenError, BadRequestError } from "../../utils/errors";
import { idempotencyKeySchema } from "./inspecciones.schema";
import type { AlcanceHistorial } from "./inspecciones.access";

const reqInfoDe = (req: Request) => ({
  ip: req.ip,
  userAgent: req.headers["user-agent"],
  method: req.method,
  url: req.originalUrl || req.url,
});

export class InspeccionesController {
  async getDashboardMetricas(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const metricas = await inspeccionesService.getDashboardMetricas();
      sendSuccess(res, metricas, "Métricas del dashboard obtenidas exitosamente");
    } catch (error) {
      next(error);
    }
  }
  async cancelarDetalle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const motivoVal = req.body?.motivo !== undefined ? String(req.body.motivo).trim() : undefined;
      const resultado = await inspeccionesService.cancelarDetalleInspeccion(Number(req.params.id), {
        usuarioId: req.user!.usuarioId,
        motivo: motivoVal || "Eliminación de defecto en estación",
        reqInfo: reqInfoDe(req),
      });
      sendSuccess(res, resultado, "Registro de defecto eliminado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async recuperarDetalle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const motivoVal = req.body?.motivo !== undefined ? String(req.body.motivo).trim() : undefined;
      const resultado = await inspeccionesService.recuperarDetalleInspeccion(Number(req.params.id), {
        usuarioId: req.user!.usuarioId,
        motivo: motivoVal || "Recuperación de defecto en estación",
        reqInfo: reqInfoDe(req),
      });
      sendSuccess(res, resultado, "Registro de defecto recuperado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async createInspeccion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { lote, lineaId, lineaTexto, horma, notas, detalles } = req.body;

      let claveIdempotencia: string | undefined;
      const claveHeader = req.headers["idempotency-key"];
      if (claveHeader !== undefined) {
        const parsed = idempotencyKeySchema.safeParse(Array.isArray(claveHeader) ? claveHeader[0] : claveHeader);
        if (!parsed.success) {
          throw new BadRequestError(parsed.error.issues[0]?.message ?? "Clave de idempotencia no válida");
        }
        claveIdempotencia = parsed.data;
      }

      const { inspeccion, repetida } = await inspeccionesService.registrarInspeccion({
        lote,
        lineaId,
        lineaTexto,
        horma,
        notas,
        detalles,
        usuarioId: req.user!.usuarioId,
        terminal: req.terminal,
        claveIdempotencia,
        reqInfo: reqInfoDe(req),
      });

      if (repetida) {
        // Reintento idempotente: misma inspección, sin duplicar registros
        res.setHeader("Idempotent-Replayed", "true");
        sendSuccess(res, inspeccion, "Inspección ya registrada previamente (reintento idempotente)");
        return;
      }
      sendCreated(res, inspeccion, "Inspección registrada exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getFilasInspeccion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // `req.query` ya fue validado y normalizado por getInspeccionesQuerySchema
      const q = req.query as unknown as Record<string, any>;
      const alcance = res.locals.alcanceHistorial as AlcanceHistorial;

      if (q.soloEliminados && !alcance.puedeVerEliminados) {
        throw new ForbiddenError("Acceso denegado: falta el permiso 'defectos.eliminar' para ver registros eliminados");
      }

      const resultado = await inspeccionesService.getFilasInspeccion({
        periodo: q.periodo || "ultimos",
        busqueda: q.busqueda || undefined,
        lote: q.lote || undefined,
        defectoClave: q.defectoClave,
        departamentoId: q.departamentoId,
        departamentoAuditoriaId: q.departamentoAuditoriaId,
        departamentoResponsableId: q.departamentoResponsableId,
        clasificacion: q.clasificacion,
        lineaId: q.lineaId,
        lineaTexto: q.lineaTexto || undefined,
        // Con alcance general, se permite filtrar opcionalmente por cualquier inspector;
        // sin alcance general, el usuario ve sus registros propios MÁS los de su estación/departamento autorizado.
        inspectorId: alcance.general ? q.inspectorId : undefined,
        alcanceRestringido: alcance.general
          ? undefined
          : {
              usuarioId: req.user!.usuarioId,
              departamentosIds: alcance.departamentosAlcanceIds,
              terminalId: req.terminal?.id,
            },
        terminalId: q.terminalId,
        fechaDesde: q.fechaDesde ? new Date(`${q.fechaDesde}T00:00:00.000Z`) : undefined,
        fechaHasta: q.fechaHasta ? new Date(`${q.fechaHasta}T23:59:59.999Z`) : undefined,
        mes: q.mes,
        anio: q.anio,
        soloEliminados: q.soloEliminados === true,
        page: q.page || 1,
        limit: q.limit || 30,
      });

      sendSuccess(res, resultado, "Filas de inspección recuperadas exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getDetalle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const alcance = res.locals.alcanceHistorial as AlcanceHistorial;
      const incluirEliminados = (req.query as any).incluirEliminados === true;
      if (incluirEliminados && !alcance.puedeVerEliminados) {
        throw new ForbiddenError("Acceso denegado: falta el permiso 'defectos.eliminar' para ver registros eliminados");
      }

      const detalle = await inspeccionesService.getDetalleInspeccion(Number(req.params.id), {
        soloPropiaDeUsuarioId: alcance.general ? undefined : req.user!.usuarioId,
        departamentosPermitidosIds: alcance.general ? undefined : alcance.departamentosAlcanceIds,
        terminalPermitidaId: alcance.general ? undefined : req.terminal?.id,
        incluirEliminados,
        incluirTrazabilidad: alcance.puedeVerTrazabilidad,
      });
      sendSuccess(res, detalle, "Detalle de inspección recuperado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getInspectores(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const inspectores = await inspeccionesService.getInspectores();
      sendSuccess(res, inspectores, "Inspectores recuperados exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async syncOfflineBatch(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { items } = req.body;
      const terminal = req.terminal!;

      const resultado = await inspeccionesService.sincronizarLoteOffline({
        items,
        terminal,
        reqInfo: reqInfoDe(req),
      });

      sendSuccess(res, resultado, "Lote de capturas offline procesado");
    } catch (error) {
      next(error);
    }
  }
}

export const inspeccionesController = new InspeccionesController();

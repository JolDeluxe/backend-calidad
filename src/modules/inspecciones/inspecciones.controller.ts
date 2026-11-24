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
  async getDashboardMetricas(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const metricas = await inspeccionesService.getDashboardMetricas(req.query as any);
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
      const { lote, lista, loteId, lineaId, lineaTexto, horma, notas, detalles } = req.body;

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
        lista,
        loteId,
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

  private construirParametrosBaseFiltro(q: Record<string, any>, req: Request, alcance: AlcanceHistorial) {
    if (q.soloEliminados && !alcance.puedeVerEliminados) {
      throw new ForbiddenError("Acceso denegado: falta el permiso 'defectos.eliminar' para ver registros eliminados");
    }

    // 1. Roles con alcance global (SUPER_ADMIN, ADMIN, COORD, VISUALIZADOR):
    // Acceso total a todos los departamentos. Pueden consultar libremente cualquier departamento o todos.
    if (alcance.general) {
      return {
        periodo: q.periodo || "ultimos",
        busqueda: q.busqueda || undefined,
        lote: q.lote || undefined,
        defectoClave: q.defectoClave,
        departamentoId: q.departamentoId,
        departamentosIds: q.departamentosIds,
        departamentoAuditoriaId: q.departamentoAuditoriaId,
        departamentoResponsableId: q.departamentoResponsableId,
        clasificacion: q.clasificacion,
        lineaId: q.lineaId,
        lineaTexto: q.lineaTexto || undefined,
        inspectorId: q.inspectorId,
        alcanceRestringido: undefined,
        departamentosPermitidosIds: undefined,
        terminalId: q.terminalId,
        dia: q.dia || undefined,
        semana: q.semana,
        anioIso: q.anioIso,
        mes: q.mes,
        anio: q.anio,
        fechaDesde: q.fechaDesde || undefined,
        fechaHasta: q.fechaHasta || undefined,
        soloEliminados: q.soloEliminados === true,
      };
    }

    // 2. Rol INSPECTOR:
    // Su departamento está determinado exclusivamente por la terminal física autenticada (puede ser multidepartamental).
    const deptosTerminal = alcance.departamentosAlcanceIds;
    if (!deptosTerminal || deptosTerminal.length === 0) {
      throw new ForbiddenError(
        "Acceso denegado: requiere terminal física vinculada y activa para consultar inspecciones de su departamento"
      );
    }

    // Seguridad: Un inspector NO puede consultar registros de departamentos fuera del alcance de su terminal
    if (q.departamentoId && !deptosTerminal.includes(Number(q.departamentoId))) {
      throw new ForbiddenError("Acceso denegado: no tiene permiso para consultar registros de otro departamento");
    }
    if (q.departamentoAuditoriaId && !deptosTerminal.includes(Number(q.departamentoAuditoriaId))) {
      throw new ForbiddenError("Acceso denegado: no tiene permiso para consultar registros de otro departamento");
    }
    if (q.departamentosIds && q.departamentosIds.length > 0) {
      for (const dId of q.departamentosIds) {
        if (!deptosTerminal.includes(Number(dId))) {
          throw new ForbiddenError("Acceso denegado: no tiene permiso para consultar registros de otro departamento");
        }
      }
    }

    // Para el inspector, se acota a los departamentos de su terminal autenticada.
    // Los registros NO son privados por inspector: NO se filtra por usuario creador.
    return {
      periodo: q.periodo || "ultimos",
      busqueda: q.busqueda || undefined,
      lote: q.lote || undefined,
      defectoClave: q.defectoClave,
      departamentoId: q.departamentoId,
      departamentosIds: q.departamentosIds,
      departamentoAuditoriaId: undefined,
      departamentoResponsableId: q.departamentoResponsableId,
      clasificacion: q.clasificacion,
      lineaId: q.lineaId,
      lineaTexto: q.lineaTexto || undefined,
      inspectorId: undefined, // Nunca se acota por creador: ve todos los registros de la terminal/departamento
      alcanceRestringido: undefined,
      departamentosPermitidosIds: deptosTerminal,
      terminalId: q.terminalId,
      dia: q.dia || undefined,
      semana: q.semana,
      anioIso: q.anioIso,
      mes: q.mes,
      anio: q.anio,
      fechaDesde: q.fechaDesde || undefined,
      fechaHasta: q.fechaHasta || undefined,
      soloEliminados: q.soloEliminados === true,
    };
  }

  async getFilasInspeccion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // `req.query` ya fue validado y normalizado por getInspeccionesQuerySchema
      const q = req.query as unknown as Record<string, any>;
      const alcance = res.locals.alcanceHistorial as AlcanceHistorial;
      const baseParams = this.construirParametrosBaseFiltro(q, req, alcance);

      const resultado = await inspeccionesService.getFilasInspeccion({
        ...baseParams,
        page: q.page || 1,
        limit: q.limit || 30,
      });

      sendSuccess(res, resultado, "Filas de inspección recuperadas exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async exportarFilasInspeccion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const q = req.query as unknown as Record<string, any>;
      const alcance = res.locals.alcanceHistorial as AlcanceHistorial;
      const baseParams = this.construirParametrosBaseFiltro(q, req, alcance);

      const resultado = await inspeccionesService.exportarFilasInspeccion({
        ...baseParams,
        page: q.page !== undefined ? Number(q.page) : undefined,
        limit: q.limit !== undefined ? Number(q.limit) : undefined,
      });
      sendSuccess(res, resultado, "Datos de exportación recuperados exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getPeriodosDisponibles(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const q = req.query as unknown as Record<string, any>;
      const alcance = res.locals.alcanceHistorial as AlcanceHistorial;
      const baseParams = this.construirParametrosBaseFiltro(q, req, alcance);

      const resultado = await inspeccionesService.getPeriodosDisponibles(baseParams);
      sendSuccess(res, resultado, "Periodos disponibles recuperados exitosamente");
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

  async getInspectores(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const q = req.query as unknown as Record<string, any>;
      // Quien consulta inspectores ya cuenta con alcance general (requireAlcanceGeneral: SUPER_ADMIN, ADMIN, COORD, VISUALIZADOR).
      // Puede consultar libremente inspectores de cualquier departamento o todos.
      const inspectores = await inspeccionesService.getInspectores({
        departamentoId: q.departamentoId,
        departamentosPermitidosIds: undefined,
      });
      sendSuccess(res, inspectores, "Inspectores activos recuperados exitosamente");
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

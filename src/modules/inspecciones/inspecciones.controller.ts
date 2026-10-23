import type { Request, Response, NextFunction } from "express";
import { inspeccionesService } from "./services/inspecciones.service";
import { sendSuccess, sendCreated } from "../../utils/response";

export class InspeccionesController {
  async createInspeccion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { lote, lineaId, departamentoAuditoriaId, horma, notas, detalles } = req.body;

      const resultado = await inspeccionesService.createInspeccion({
        lote,
        lineaId,
        departamentoAuditoriaId,
        horma,
        notas,
        detalles,
        usuarioId: req.user!.usuarioId,
        terminal: req.terminal,
        reqInfo: {
          ip: req.ip,
          userAgent: req.headers["user-agent"],
          method: req.method,
          url: req.originalUrl || req.url,
        },
      });

      sendCreated(res, resultado, "Inspección registrada exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getFilasInspeccion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const {
        periodo,
        busqueda,
        lote,
        defectoClave,
        departamentoAuditoriaId,
        inspectorId,
        mes,
        anio,
        page,
        limit,
      } = req.query as unknown as {
        periodo?: "hoy" | "ultimos" | "todos";
        busqueda?: string;
        lote?: string;
        defectoClave?: number;
        departamentoAuditoriaId?: number;
        inspectorId?: number;
        mes?: number;
        anio?: number;
        page: number;
        limit: number;
      };

      const resultado = await inspeccionesService.getFilasInspeccion({
        periodo: periodo || "ultimos",
        busqueda,
        lote,
        defectoClave: defectoClave ? Number(defectoClave) : undefined,
        departamentoAuditoriaId: departamentoAuditoriaId ? Number(departamentoAuditoriaId) : undefined,
        inspectorId: inspectorId ? Number(inspectorId) : undefined,
        mes: mes ? Number(mes) : undefined,
        anio: anio ? Number(anio) : undefined,
        page: Number(page) || 1,
        limit: Number(limit) || 30,
      });

      sendSuccess(res, resultado, "Filas de inspección recuperadas exitosamente");
    } catch (error) {
      next(error);
    }
  }
}

export const inspeccionesController = new InspeccionesController();

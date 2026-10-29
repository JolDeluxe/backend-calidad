import type { Request, Response, NextFunction } from "express";
import { proyeccionService } from "./proyeccion.service";
import { sendSuccess } from "../../utils/response";

export class ProyeccionController {
  async getResumenGeneral(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const semana = req.query.semana ? Number(req.query.semana) : undefined;
      const anio = req.query.anio ? Number(req.query.anio) : undefined;
      const data = await proyeccionService.getResumenGeneral(semana, anio);
      sendSuccess(res, data, "Resumen general de planta obtenido exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getReporteSemanal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const semana = req.query.semana ? Number(req.query.semana) : undefined;
      const anio = req.query.anio ? Number(req.query.anio) : undefined;
      const data = await proyeccionService.getReporteSemanal(semana, anio);
      sendSuccess(res, data, "Reporte semanal de proyección obtenido exitosamente");
    } catch (error) {
      next(error);
    }
  }
}

export const proyeccionController = new ProyeccionController();

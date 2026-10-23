import type { Request, Response, NextFunction } from "express";
import { tiposOperacionService } from "../services/tipos-operacion.service";
import { sendSuccess, sendCreated } from "../../../utils/response";

export class TiposOperacionController {
  async getTiposOperacion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const incluirInactivos = req.query.incluirInactivos === "true";
      const tipos = await tiposOperacionService.getTiposOperacion(incluirInactivos);
      sendSuccess(res, tipos, "Tipos de operación obtenidos exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getTipoOperacionById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tipo = await tiposOperacionService.getTipoOperacionById(Number(req.params.id));
      sendSuccess(res, tipo, "Tipo de operación obtenido exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async createTipoOperacion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tipo = await tiposOperacionService.createTipoOperacion(req.body, req.user?.usuarioId);
      sendCreated(res, tipo, "Tipo de operación creado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async updateTipoOperacion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tipo = await tiposOperacionService.updateTipoOperacion(Number(req.params.id), req.body, req.user?.usuarioId);
      sendSuccess(res, tipo, "Tipo de operación actualizado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async updateEstadoTipoOperacion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { estado } = req.body;
      const tipo = await tiposOperacionService.updateTipoOperacion(Number(req.params.id), { estado }, req.user?.usuarioId);
      sendSuccess(res, tipo, `Tipo de operación ${estado === "ACTIVO" ? "activado" : "desactivado"} exitosamente`);
    } catch (error) {
      next(error);
    }
  }

  async deleteTipoOperacion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const resultado = await tiposOperacionService.deleteTipoOperacion(Number(req.params.id), req.user?.usuarioId);
      sendSuccess(res, resultado, "Tipo de operación eliminado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  // --- LÍNEAS ---
  async getLineas(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tipoOperacionId = req.query.tipoOperacionId ? Number(req.query.tipoOperacionId) : undefined;
      const incluirInactivas = req.query.incluirInactivas === "true";
      const lineas = await tiposOperacionService.getLineas(tipoOperacionId, incluirInactivas);
      sendSuccess(res, lineas, "Líneas obtenidas exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getLineaById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const linea = await tiposOperacionService.getLineaById(Number(req.params.id));
      sendSuccess(res, linea, "Línea obtenida exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async createLinea(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const linea = await tiposOperacionService.createLinea(req.body, req.user?.usuarioId);
      sendCreated(res, linea, "Línea creada exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async updateLinea(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const linea = await tiposOperacionService.updateLinea(Number(req.params.id), req.body, req.user?.usuarioId);
      sendSuccess(res, linea, "Línea actualizada exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async updateEstadoLinea(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { estado } = req.body;
      const linea = await tiposOperacionService.updateLinea(Number(req.params.id), { estado }, req.user?.usuarioId);
      sendSuccess(res, linea, `Línea ${estado === "ACTIVO" ? "activada" : "desactivada"} exitosamente`);
    } catch (error) {
      next(error);
    }
  }

  async deleteLinea(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const resultado = await tiposOperacionService.deleteLinea(Number(req.params.id), req.user?.usuarioId);
      sendSuccess(res, resultado, "Línea eliminada exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async syncLineaDepartamentos(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const asociaciones = await tiposOperacionService.syncLineaDepartamentos(
        Number(req.params.id),
        req.body.departamentos,
        req.user?.usuarioId
      );
      sendSuccess(res, asociaciones, "Departamentos de línea actualizados exitosamente");
    } catch (error) {
      next(error);
    }
  }
}

export const tiposOperacionController = new TiposOperacionController();

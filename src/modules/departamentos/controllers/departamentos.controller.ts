import type { Request, Response, NextFunction } from "express";
import { departamentosService } from "../services/departamentos.service";
import { sendSuccess, sendCreated } from "../../../utils/response";

export class DepartamentosController {
  async getDepartamentos(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { lineaId, tipoOperacionId, categoriaDepartamentoId, estado, busqueda, incluirEliminados } = req.query as any;
      const departamentos = await departamentosService.getDepartamentos({
        lineaId,
        tipoOperacionId,
        categoriaDepartamentoId,
        estado,
        busqueda,
        incluirEliminados,
      });
      sendSuccess(res, departamentos, "Departamentos obtenidos exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getDepartamentoById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const departamento = await departamentosService.getDepartamentoById(Number(req.params.id));
      sendSuccess(res, departamento, "Departamento obtenido exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async createDepartamento(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const depto = await departamentosService.createDepartamento(req.body, req.user?.usuarioId);
      sendCreated(res, depto, "Departamento creado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async updateDepartamento(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const depto = await departamentosService.updateDepartamento(
        Number(req.params.id),
        req.body,
        req.user?.usuarioId
      );
      sendSuccess(res, depto, "Departamento actualizado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async updateEstadoDepartamento(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const depto = await departamentosService.updateEstadoDepartamento(
        Number(req.params.id),
        req.body.estado,
        req.user?.usuarioId
      );
      sendSuccess(res, depto, "Estado de departamento modificado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async deleteDepartamento(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const resultado = await departamentosService.deleteDepartamento(
        Number(req.params.id),
        req.user?.usuarioId
      );
      sendSuccess(res, resultado, "Departamento eliminado lógicamente exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async syncDepartamentoLineas(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const lineas = await departamentosService.syncDepartamentoLineas(
        Number(req.params.id),
        req.body.lineas,
        req.user?.usuarioId
      );
      sendSuccess(res, lineas, "Líneas de departamento sincronizadas exitosamente");
    } catch (error) {
      next(error);
    }
  }
}

export const departamentosController = new DepartamentosController();

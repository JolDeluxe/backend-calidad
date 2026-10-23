import type { Request, Response, NextFunction } from "express";
import { categoriasDepartamentoService } from "../services/categorias-departamento.service";

export class CategoriasDepartamentoController {
  async getCategorias(req: Request, res: Response, next: NextFunction) {
    try {
      const { activo, busqueda, incluirEliminados } = req.query as any;
      const categorias = await categoriasDepartamentoService.getCategorias({
        activo: activo !== undefined ? activo === "true" : undefined,
        busqueda: busqueda as string,
        incluirEliminados: incluirEliminados === "true",
      });
      res.status(200).json({
        success: true,
        data: categorias,
      });
    } catch (error) {
      next(error);
    }
  }

  async getCategoriaById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = Number(req.params.id);
      const categoria = await categoriasDepartamentoService.getCategoriaById(id);
      res.status(200).json({
        success: true,
        data: categoria,
      });
    } catch (error) {
      next(error);
    }
  }

  async createCategoria(req: Request, res: Response, next: NextFunction) {
    try {
      const usuarioId = req.user?.usuarioId;
      const categoria = await categoriasDepartamentoService.createCategoria(req.body, usuarioId);
      res.status(201).json({
        success: true,
        data: categoria,
        message: "Categoría de departamento creada exitosamente",
      });
    } catch (error) {
      next(error);
    }
  }

  async updateCategoria(req: Request, res: Response, next: NextFunction) {
    try {
      const id = Number(req.params.id);
      const usuarioId = req.user?.usuarioId;
      const categoria = await categoriasDepartamentoService.updateCategoria(id, req.body, usuarioId);
      res.status(200).json({
        success: true,
        data: categoria,
        message: "Categoría de departamento actualizada exitosamente",
      });
    } catch (error) {
      next(error);
    }
  }

  async updateEstado(req: Request, res: Response, next: NextFunction) {
    try {
      const id = Number(req.params.id);
      const { activo } = req.body;
      const usuarioId = req.user?.usuarioId;
      const categoria = await categoriasDepartamentoService.updateEstado(id, activo, usuarioId);
      res.status(200).json({
        success: true,
        data: categoria,
        message: `Categoría de departamento ${activo ? "activada" : "desactivada"} exitosamente`,
      });
    } catch (error) {
      next(error);
    }
  }

  async deleteCategoria(req: Request, res: Response, next: NextFunction) {
    try {
      const id = Number(req.params.id);
      const usuarioId = req.user?.usuarioId;
      const resultado = await categoriasDepartamentoService.deleteCategoria(id, usuarioId);
      res.status(200).json({
        success: true,
        data: resultado,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const categoriasDepartamentoController = new CategoriasDepartamentoController();

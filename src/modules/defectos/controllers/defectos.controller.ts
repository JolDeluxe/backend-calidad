import type { Request, Response, NextFunction } from "express";
import { defectosService } from "../services/defectos.service";
import { codificacionDefectosService } from "../services/codificacion-defectos.service";
import { sendSuccess, sendCreated } from "../../../utils/response";
import { UnauthorizedError } from "../../../utils/errors";

export class DefectosController {
  async getDefectos(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const {
        clave,
        texto,
        busqueda,
        clasificacion,
        departamentoId,
        categoriaDepartamentoId,
        lineaId,
        lineasIds,
        activo,
        incluirEliminados,
        soloEliminados,
        limit,
        page,
      } = req.query as any;

      const defectos = await defectosService.getDefectos({
        clave,
        texto,
        busqueda,
        clasificacion,
        departamentoId,
        categoriaDepartamentoId,
        lineaId: lineaId ? Number(lineaId) : undefined,
        lineasIds: Array.isArray(lineasIds) && lineasIds.length > 0 ? lineasIds : undefined,
        activo,
        incluirEliminados,
        soloEliminados,
        limit,
        page,
      });

      sendSuccess(res, defectos, "Defectos obtenidos exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getConteoLineas(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const conteos = await defectosService.getConteoLineas();
      sendSuccess(res, conteos, "Conteos de defectos por línea obtenidos exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getGruposCodificacion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { lineaId } = req.query as { lineaId?: number | string };
      const grupos = await codificacionDefectosService.getGrupos(lineaId ? Number(lineaId) : undefined);
      sendSuccess(res, grupos, "Grupos de codificación obtenidos exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async previsualizarLote(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const resultado = await codificacionDefectosService.previsualizarLote(req.body);
      sendSuccess(res, resultado, "Previsualización de claves generada (sin reservar claves)");
    } catch (error) {
      next(error);
    }
  }

  async crearLote(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Usuario no autenticado");
      }
      const resultado = await codificacionDefectosService.crearLote(req.body, req.user.usuarioId);
      sendCreated(res, resultado, "Lote de defectos creado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getDefectoById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const defecto = await defectosService.getDefectoById(Number(req.params.id));
      sendSuccess(res, defecto, "Defecto obtenido exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async createDefecto(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Usuario no autenticado");
      }
      const nuevo = await defectosService.createDefecto(req.body, req.user.usuarioId);
      sendCreated(res, nuevo, "Defecto creado y clave asignada automáticamente");
    } catch (error) {
      next(error);
    }
  }

  async updateDefecto(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Usuario no autenticado");
      }
      const actualizado = await defectosService.updateDefecto(
        Number(req.params.id),
        req.body,
        req.user.usuarioId
      );
      sendSuccess(res, actualizado, "Defecto actualizado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async updateClaveDefecto(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Usuario no autenticado");
      }
      const { nuevaClave } = req.body;
      const actualizado = await defectosService.updateClaveDefecto(
        Number(req.params.id),
        Number(nuevaClave),
        req.user.usuarioId
      );
      sendSuccess(res, actualizado, "Clave de defecto actualizada y secuencia sincronizada exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async updateEstadoDefecto(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Usuario no autenticado");
      }
      const { activo } = req.body;
      const actualizado = await defectosService.updateEstadoDefecto(
        Number(req.params.id),
        activo,
        req.user.usuarioId
      );
      sendSuccess(res, actualizado, "Estado de defecto modificado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async deleteDefecto(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Usuario no autenticado");
      }
      const resultado = await defectosService.deleteDefecto(
        Number(req.params.id),
        req.user.usuarioId
      );
      sendSuccess(res, resultado, "Defecto eliminado lógicamente exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async reactivarDefecto(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Usuario no autenticado");
      }
      const resultado = await defectosService.reactivarDefecto(
        Number(req.params.id),
        req.user.usuarioId
      );
      sendSuccess(res, resultado, "Defecto reactivado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async syncDefectoDepartamentos(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Usuario no autenticado");
      }
      const resultados = await defectosService.syncDefectoDepartamentos(
        Number(req.params.id),
        req.body.departamentos,
        req.user.usuarioId
      );
      sendSuccess(res, resultados, "Departamentos del defecto sincronizados exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async toggleDefectoDepartamento(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Usuario no autenticado");
      }
      const resultado = await defectosService.toggleDefectoDepartamento(
        Number(req.params.id),
        Number(req.params.departamentoId),
        req.body.activo,
        req.user.usuarioId
      );
      sendSuccess(res, resultado, "Asociación defecto-departamento actualizada exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async syncDefectoEtapas(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Usuario no autenticado");
      }
      const resultados = await defectosService.syncDefectoEtapas(
        Number(req.params.id),
        req.body.etapas,
        req.user.usuarioId
      );
      sendSuccess(res, resultados, "Matriz de etapas de detección actualizada exitosamente");
    } catch (error) {
      next(error);
    }
  }
}

export const defectosController = new DefectosController();

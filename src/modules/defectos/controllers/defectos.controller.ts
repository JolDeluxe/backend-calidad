import type { Request, Response, NextFunction } from "express";
import { defectosService } from "../services/defectos.service";
import { codificacionDefectosService } from "../services/codificacion-defectos.service";
import { matrizVisibilidadDefectosService } from "../services/matriz-visibilidad.service";
import { auditService } from "../../audit/services/audit.service";
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
        etapaId,
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
        etapaId: etapaId ? Number(etapaId) : undefined,
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

  async validarDefectoCaptura(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { clave, etapaId } = req.query as unknown as { clave: number; etapaId: number };
      const resultado = await defectosService.validarDefectoParaCaptura(clave, etapaId);
      sendSuccess(res, resultado, resultado.mensaje);
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

  async getMatrizVisibilidad(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await matrizVisibilidadDefectosService.getMatrizCompleta();
      sendSuccess(res, data, "Matriz de visibilidad de defectos obtenida exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getMatrizVisibilidadPorDepartamento(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await matrizVisibilidadDefectosService.getMatrizPorDepartamento(
        Number(req.params.departamentoOrigenId)
      );
      sendSuccess(res, data, "Matriz de visibilidad del departamento obtenida exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async upsertReglaVisibilidad(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new UnauthorizedError("Usuario no autenticado");
      const { departamentoOrigenId, departamentoDestinoId, permitido } = req.body;
      const { regla, anterior, origen, destino } = await matrizVisibilidadDefectosService.upsertRegla(
        Number(departamentoOrigenId),
        Number(departamentoDestinoId),
        Boolean(permitido),
        req.user.usuarioId
      );

      await auditService.registrarEvento({
        accion: "MATRIZ_VISIBILIDAD_MODIFICADA",
        modulo: "CATALOGOS",
        entidad: "DepartamentoVisibilidadDefecto",
        entidadId: `${origen.id}-${destino.id}`,
        descripcion: `Regla de visibilidad actualizada: Defectos de ${origen.nombre} en ${destino.nombre} -> ${permitido ? "PERMITIDO" : "BLOQUEADO"}`,
        valoresAnteriores: anterior as any,
        valoresPosteriores: regla as any,
        contexto: { usuarioId: req.user.usuarioId },
      });

      sendSuccess(res, regla, "Regla de visibilidad guardada exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async actualizarMatrizDepartamento(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new UnauthorizedError("Usuario no autenticado");
      const { departamentoOrigenId, destinos } = req.body;
      const resultado = await matrizVisibilidadDefectosService.actualizarMatrizDepartamento(
        Number(departamentoOrigenId),
        destinos,
        req.user.usuarioId
      );

      await auditService.registrarEvento({
        accion: "MATRIZ_VISIBILIDAD_COMPLETA_MODIFICADA",
        modulo: "CATALOGOS",
        entidad: "DepartamentoVisibilidadDefecto",
        entidadId: String(departamentoOrigenId),
        descripcion: `Matriz de visibilidad para departamento ID ${departamentoOrigenId} actualizada (${destinos.length} reglas)`,
        valoresPosteriores: { departamentoOrigenId, reglas: destinos },
        contexto: { usuarioId: req.user.usuarioId },
      });

      sendSuccess(res, resultado, "Matriz de visibilidad actualizada exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async resolverVisibilidad(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { defectoId, departamentoDeteccionId } = req.query as unknown as {
        defectoId: number;
        departamentoDeteccionId: number;
      };
      const resultado = await matrizVisibilidadDefectosService.resolverVisibilidad(
        Number(defectoId),
        Number(departamentoDeteccionId)
      );
      sendSuccess(res, resultado, "Visibilidad resuelta exitosamente");
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

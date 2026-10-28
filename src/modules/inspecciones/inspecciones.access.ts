import type { Request, Response, NextFunction } from "express";
import { ForbiddenError } from "../../utils/errors";
import { permissionsService } from "../auth/services/permissions.service";

/**
 * Alcance de consulta del historial de inspecciones, resuelto en el servidor a partir de permisos efectivos:
 * - `defectos.consultar_departamento` => historial general (ADMIN, COORD, SUPER_ADMIN según seed).
 * - `defectos.consultar_propios`      => únicamente inspecciones registradas por el propio usuario (INSPECTOR).
 * - Ninguno                           => acceso denegado.
 */
export interface AlcanceHistorial {
  general: boolean;
  puedeVerEliminados: boolean;
  puedeVerTrazabilidad: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      alcanceHistorial?: AlcanceHistorial;
    }
  }
}

export const resolverAlcanceHistorial = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const usuarioId = req.user!.usuarioId;
    const [general, propios, eliminar, auditar] = await Promise.all([
      permissionsService.hasPermission(usuarioId, "defectos.consultar_departamento"),
      permissionsService.hasPermission(usuarioId, "defectos.consultar_propios"),
      permissionsService.hasPermission(usuarioId, "defectos.eliminar"),
      permissionsService.hasPermission(usuarioId, "auditoria.consultar"),
    ]);

    if (!general && !propios) {
      throw new ForbiddenError("Acceso denegado: falta permiso para consultar inspecciones");
    }

    res.locals.alcanceHistorial = {
      general,
      puedeVerEliminados: eliminar,
      puedeVerTrazabilidad: auditar,
    } satisfies AlcanceHistorial;
    next();
  } catch (error) {
    next(error);
  }
};

/** Solo quienes tienen alcance general pueden listar inspectores (catálogo para filtros). */
export const requireAlcanceGeneral = (_req: Request, res: Response, next: NextFunction): void => {
  if (!res.locals.alcanceHistorial?.general) {
    return next(new ForbiddenError("Acceso denegado: requiere alcance de consulta general"));
  }
  next();
};

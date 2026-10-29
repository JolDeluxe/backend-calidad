import type { Request, Response, NextFunction } from "express";
import { ForbiddenError } from "../../utils/errors";
import { permissionsService } from "../auth/services/permissions.service";
import { terminalsService } from "../auth/services/terminals.service";

/**
 * Alcance de consulta del historial de inspecciones, resuelto en el servidor a partir de permisos efectivos:
 * - `defectos.consultar_departamento` => historial general (ADMIN, COORD, SUPER_ADMIN según seed).
 * - `defectos.consultar_propios`      => inspecciones propias del inspector + las registradas en la terminal/departamento activo (INSPECTOR).
 * - Ninguno                           => acceso denegado.
 */
export interface AlcanceHistorial {
  general: boolean;
  puedeVerEliminados: boolean;
  puedeVerTrazabilidad: boolean;
  departamentosAlcanceIds: number[];
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
    const [efectivos, general, propios, eliminar, auditar] = await Promise.all([
      permissionsService.getPermisosEfectivos(usuarioId),
      permissionsService.hasPermission(usuarioId, "defectos.consultar_departamento"),
      permissionsService.hasPermission(usuarioId, "defectos.consultar_propios"),
      permissionsService.hasPermission(usuarioId, "defectos.eliminar"),
      permissionsService.hasPermission(usuarioId, "auditoria.consultar"),
    ]);

    if (!general && !propios) {
      throw new ForbiddenError("Acceso denegado: falta permiso para consultar inspecciones");
    }

    // Resolver opcionalmente la terminal física si viene en la cabecera x-terminal-credential
    const credencial = req.headers["x-terminal-credential"] as string | undefined;
    if (credencial && !req.terminal) {
      try {
        const terminal = await terminalsService.validateTerminal(credencial);
        req.terminal = {
          id: terminal.id,
          nombre: terminal.nombre,
          departamentoId: terminal.departamentoId,
        };
      } catch {
        // Si la terminal fue revocada o desactivada, no bloqueamos la consulta del historial:
        // el usuario conserva su alcance por departamento o registros propios sin perder la información.
      }
    }

    const deptoSet = new Set<number>(efectivos.departamentosIds || []);
    if (req.terminal?.departamentoId) {
      deptoSet.add(req.terminal.departamentoId);
    }

    res.locals.alcanceHistorial = {
      general,
      puedeVerEliminados: eliminar,
      puedeVerTrazabilidad: auditar,
      departamentosAlcanceIds: Array.from(deptoSet),
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

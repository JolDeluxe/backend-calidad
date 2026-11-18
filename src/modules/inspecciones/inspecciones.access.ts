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
  rolCodigo: string;
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
          departamentosIds: terminal.departamentosIds,
          departamentosActivos: terminal.departamentosActivos,
          lugarDeteccion: terminal.lugarDeteccion,
        };
      } catch {
        // Si la terminal fue revocada o desactivada, no bloqueamos la consulta del historial:
        // el usuario conserva su alcance por departamento o registros propios sin perder la información.
      }
    }

    // ROLES CON ALCANCE GLOBAL DE CONSULTA:
    // SUPER_ADMIN, ADMIN, COORD y VISUALIZADOR (o quien posea defectos.consultar_departamento).
    // Tienen acceso global irrestricto a todos los departamentos y nunca quedan acotados por asignaciones residuales ni terminales físicas.
    const esRolGlobal =
      general ||
      efectivos.rolCodigo === "SUPER_ADMIN" ||
      efectivos.rolCodigo === "ADMIN" ||
      efectivos.rolCodigo === "COORD" ||
      efectivos.rolCodigo === "VISUALIZADOR";

    let departamentosAlcanceIds: number[] = [];

    if (esRolGlobal) {
      // Alcance global irrestricto
      departamentosAlcanceIds = [];
    } else {
      // ROL INSPECTOR:
      // El contexto departamental de trabajo se determina EXCLUSIVAMENTE mediante la terminal física autenticada.
      // Un inspector no está asignado permanentemente a un departamento; puede trabajar desde cualquier terminal.
      if (req.terminal?.departamentosIds && req.terminal.departamentosIds.length > 0) {
        departamentosAlcanceIds = req.terminal.departamentosIds;
      } else if (req.terminal?.departamentoId) {
        departamentosAlcanceIds = [req.terminal.departamentoId];
      } else {
        departamentosAlcanceIds = [];
      }
    }

    res.locals.alcanceHistorial = {
      general: esRolGlobal,
      rolCodigo: efectivos.rolCodigo,
      puedeVerEliminados: eliminar,
      puedeVerTrazabilidad: auditar,
      departamentosAlcanceIds,
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

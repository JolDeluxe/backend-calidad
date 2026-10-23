import type { Request, Response, NextFunction } from "express";
import { UnauthorizedError, ForbiddenError } from "../utils/errors";
import { securityService, type TokenPayload } from "../modules/auth/services/security.service";
import { sessionService } from "../modules/auth/services/session.service";
import { permissionsService } from "../modules/auth/services/permissions.service";
import { terminalsService } from "../modules/auth/services/terminals.service";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: TokenPayload;
      terminal?: {
        id: number;
        nombre: string;
        departamentoId: number;
      };
    }
  }
}

export const authenticate = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new UnauthorizedError("Token de acceso no proporcionado o formato inválido");
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      throw new UnauthorizedError("Token de acceso no proporcionado");
    }

    const decoded = securityService.verifyAccessToken(token);
    if (!decoded) {
      throw new UnauthorizedError("Token de acceso inválido o expirado");
    }

    await sessionService.validateActiveUser(decoded.usuarioId);

    // Validación estricta de sesión: todo token debe tener sesionId asociado y dicha sesión debe estar activa en MySQL
    if (!decoded.sesionId) {
      throw new UnauthorizedError("Token de acceso sin identificador de sesión válido");
    }

    await sessionService.validateActiveSession(decoded.sesionId);

    req.user = decoded;
    next();
  } catch (error) {
    next(error);
  }
};

export const requireRole = (allowedRoles: string[]) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new UnauthorizedError("Usuario no autenticado");
    }

    const rol = req.user.rolCodigo.toUpperCase();
    if (!allowedRoles.map((r) => r.toUpperCase()).includes(rol)) {
      throw new ForbiddenError("Acceso denegado: rol no autorizado");
    }

    next();
  };
};

/**
 * Middleware de autorización granular por permiso (con resolución de excepciones).
 */
export const requirePermission = (codigoPermiso: string) => {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Usuario no autenticado");
      }

      // Regla de resolución de permisos individuales
      const tienePermiso = await permissionsService.hasPermission(req.user.usuarioId, codigoPermiso);
      if (!tienePermiso) {
        throw new ForbiddenError(`Acceso denegado: falta el permiso '${codigoPermiso}'`);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Middleware para validar que el usuario tenga alcance sobre el departamento objetivo.
 */
export const requireDepartmentScope = (getDeptoId: (req: Request) => number) => {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Usuario no autenticado");
      }

      const deptoId = getDeptoId(req);
      const tieneAlcance = await permissionsService.hasDepartmentScope(req.user.usuarioId, deptoId);
      if (!tieneAlcance) {
        throw new ForbiddenError("Acceso denegado: usuario sin alcance sobre el departamento");
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Middleware para validar obligatoriamente la terminal vinculada (para módulo de captura).
 * Lee el encabezado 'x-terminal-credential' y asegura que esté activa y asociada al departamento.
 */
export const requireTerminal = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const credencial = req.headers["x-terminal-credential"] as string;
    const terminal = await terminalsService.validateTerminal(credencial);

    req.terminal = {
      id: terminal.id,
      nombre: terminal.nombre,
      departamentoId: terminal.departamentoId,
    };

    next();
  } catch (error) {
    next(error);
  }
};

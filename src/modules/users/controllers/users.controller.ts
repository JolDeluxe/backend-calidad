import type { Request, Response, NextFunction } from "express";
import { usersService } from "../services/users.service";
import { sendSuccess, sendCreated } from "../../../utils/response";

export class UsersController {
  async getUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const users = await usersService.getUsers(req.user?.rolCodigo);
      sendSuccess(res, users, "Usuarios obtenidos exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getUserById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await usersService.getUserById(Number(req.params.id), req.user?.rolCodigo);
      sendSuccess(res, user, "Usuario obtenido exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async suggestUsername(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const nombre = String(req.query.nombre || "");
      const excludeId = req.query.excludeId ? Number(req.query.excludeId) : undefined;
      const result = await usersService.suggestUsername(nombre, excludeId);
      sendSuccess(res, result, "Nombre de usuario sugerido");
    } catch (error) {
      next(error);
    }
  }

  async createUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await usersService.createUser(req.body, req.user?.usuarioId, req.user?.rolCodigo);
      sendCreated(res, user, "Usuario creado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async updateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await usersService.updateUser(
        Number(req.params.id),
        req.body,
        req.user?.usuarioId,
        req.user?.rolCodigo
      );
      sendSuccess(res, user, "Usuario actualizado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async deleteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await usersService.deleteUser(
        Number(req.params.id),
        req.user?.usuarioId,
        req.user?.rolCodigo
      );
      sendSuccess(res, result, "Usuario inactivado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getRoles(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const roles = await usersService.getRoles(req.user?.rolCodigo);
      sendSuccess(res, roles, "Roles obtenidos exitosamente");
    } catch (error) {
      next(error);
    }
  }
}

export const usersController = new UsersController();

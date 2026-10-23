import type { Request, Response, NextFunction } from "express";
import { usersService } from "../services/users.service";
import { sendSuccess, sendCreated } from "../../../utils/response";

export class UsersController {
  async getUsers(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const users = await usersService.getUsers();
      sendSuccess(res, users, "Usuarios obtenidos exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getUserById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await usersService.getUserById(Number(req.params.id));
      sendSuccess(res, user, "Usuario obtenido exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async createUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await usersService.createUser(req.body, req.user?.usuarioId);
      sendCreated(res, user, "Usuario creado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async updateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await usersService.updateUser(Number(req.params.id), req.body, req.user?.usuarioId);
      sendSuccess(res, user, "Usuario actualizado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async deleteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await usersService.deleteUser(Number(req.params.id), req.user?.usuarioId);
      sendSuccess(res, result, "Usuario inactivado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async getRoles(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const roles = await usersService.getRoles();
      sendSuccess(res, roles, "Roles obtenidos exitosamente");
    } catch (error) {
      next(error);
    }
  }
}

export const usersController = new UsersController();
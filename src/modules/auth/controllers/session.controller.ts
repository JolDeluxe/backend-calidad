import type { Request, Response, NextFunction } from "express";
import { sessionService } from "../services/session.service";
import { sendSuccess } from "../../../utils/response";
import { env } from "../../../config/env";

export class SessionController {
  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
      const userAgent = req.headers["user-agent"];

      const result = await sessionService.login(req.body, ip, userAgent);

      res.cookie(env.SESSION_COOKIE_NAME, result.refreshToken, {
        httpOnly: env.SESSION_COOKIE_HTTP_ONLY,
        secure: env.SESSION_COOKIE_SECURE,
        sameSite: env.SESSION_COOKIE_SAME_SITE,
        maxAge: env.SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000,
        path: "/",
      });

      sendSuccess(
        res,
        {
          usuario: result.usuario,
          accessToken: result.accessToken,
        },
        "Inicio de sesión exitoso",
      );
    } catch (error) {
      next(error);
    }
  }

  async refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const refreshToken = (req as unknown as { cookies?: Record<string, string> }).cookies?.[env.SESSION_COOKIE_NAME];
      const result = await sessionService.refresh(refreshToken);

      // Si la sesión fue extendida deslizantemente, renovamos la cookie con el tiempo máximo actualizado
      if (result.sessionExtended && refreshToken) {
        res.cookie(env.SESSION_COOKIE_NAME, refreshToken, {
          httpOnly: env.SESSION_COOKIE_HTTP_ONLY,
          secure: env.SESSION_COOKIE_SECURE,
          sameSite: env.SESSION_COOKIE_SAME_SITE,
          maxAge: env.SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000,
          path: "/",
        });
      }

      sendSuccess(res, result, "Token renovado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const refreshToken = (req as unknown as { cookies?: Record<string, string> }).cookies?.[env.SESSION_COOKIE_NAME];
      const result = await sessionService.logout(refreshToken);

      res.clearCookie(env.SESSION_COOKIE_NAME, {
        httpOnly: env.SESSION_COOKIE_HTTP_ONLY,
        secure: env.SESSION_COOKIE_SECURE,
        sameSite: env.SESSION_COOKIE_SAME_SITE,
        path: "/",
      });

      sendSuccess(res, result, "Cierre de sesión exitoso");
    } catch (error) {
      next(error);
    }
  }

  async getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, message: "No autenticado" });
        return;
      }
      sendSuccess(res, { user: req.user }, "Perfil obtenido exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async exchangeOfflineToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const terminal = req.terminal!;
      const { offlineToken } = req.body;
      const { offlineAuthService } = await import("../services/offline-auth.service");

      const payload = offlineAuthService.verifyOfflineToken(offlineToken);

      // Verificar que el token offline pertenezca a la misma terminal física
      if (payload.terminalId !== terminal.id) {
        res.status(401).json({
          success: false,
          message: "El token offline no corresponde a la terminal física vinculada",
        });
        return;
      }

      const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
      const userAgent = req.headers["user-agent"];

      const result = await sessionService.exchangeOfflineToken(
        payload.sub,
        terminal.id,
        ip,
        userAgent,
      );

      res.cookie(env.SESSION_COOKIE_NAME, result.refreshToken, {
        httpOnly: env.SESSION_COOKIE_HTTP_ONLY,
        secure: env.SESSION_COOKIE_SECURE,
        sameSite: env.SESSION_COOKIE_SAME_SITE,
        maxAge: env.SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000,
        path: "/",
      });

      sendSuccess(
        res,
        {
          usuario: result.usuario,
          accessToken: result.accessToken,
        },
        "Sesión en línea activada automáticamente desde credencial offline",
      );
    } catch (error) {
      next(error);
    }
  }
}

export const sessionController = new SessionController();
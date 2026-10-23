import type { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/errors";
import { logger } from "../utils/logger";
import { env } from "../config/env";
import { technicalLogger } from "../utils/technical-logger";
import type { RequestWithTracking } from "./correlation";

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  const reqWithTracking = req as RequestWithTracking;
  const requestId = reqWithTracking.requestId;
  const correlationId = reqWithTracking.correlationId;

  // Registrar en el log técnico persistente rotado
  technicalLogger.error(err.message, {
    requestId,
    correlationId,
    method: req.method,
    url: req.originalUrl || req.url,
    ip: req.ip,
    usuarioId: (req as unknown as { user?: { usuarioId: number } }).user?.usuarioId,
    statusCode: err instanceof AppError ? err.statusCode : 500,
    stack: err.stack,
  });

  if (err instanceof AppError) {
    if (!err.isOperational) {
      logger.error({ err }, "Error no operacional detectado");
    }
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
      requestId,
      correlationId,
      ...(err.errors !== undefined && { errors: err.errors }),
    });
    return;
  }

  logger.error({ err }, "Error no controlado / inesperado");

  res.status(500).json({
    success: false,
    message: "Error interno del servidor",
    requestId,
    correlationId,
  });
};

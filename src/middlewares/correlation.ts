import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export interface RequestWithTracking extends Request {
  requestId?: string;
  correlationId?: string;
  startTimeMs?: number;
}

export const correlationMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const reqWithTracking = req as RequestWithTracking;

  // Correlation ID puede venir del frontend o un gateway existente, o se genera uno nuevo
  const incomingCorrelationId =
    (req.headers["x-correlation-id"] as string | undefined) ||
    (req.headers["x-request-id"] as string | undefined);

  const correlationId = incomingCorrelationId || crypto.randomUUID();
  const requestId = crypto.randomUUID();

  reqWithTracking.correlationId = correlationId;
  reqWithTracking.requestId = requestId;
  reqWithTracking.startTimeMs = Date.now();

  // Exponer cabeceras de respuesta para correlación cliente-servidor
  res.setHeader("X-Correlation-Id", correlationId);
  res.setHeader("X-Request-Id", requestId);

  next();
};

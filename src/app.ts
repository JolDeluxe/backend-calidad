import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./utils/logger";
import { globalRateLimiter } from "./middlewares/rateLimiter";
import { errorHandler } from "./middlewares/errorHandler";
import { correlationMiddleware } from "./middlewares/correlation";
import { v1Router } from "./routes";
import { sendSuccess } from "./utils/response";
import { NotFoundError } from "./utils/errors";

export const createApp = (): Express => {
  const app = express();

  if (env.TRUST_PROXY) {
    app.set("trust proxy", 1);
  }

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
    }),
  );
  app.use(compression());

  app.use((req, _res, next) => {
    const cookieHeader = req.headers.cookie;
    const cookies: Record<string, string> = {};
    if (cookieHeader) {
      const pairs = cookieHeader.split(";");
      for (const pair of pairs) {
        const idx = pair.indexOf("=");
        if (idx > 0) {
          const key = pair.substring(0, idx).trim();
          const val = decodeURIComponent(pair.substring(idx + 1).trim());
          cookies[key] = val;
        }
      }
    }
    (req as unknown as { cookies: Record<string, string> }).cookies = cookies;
    next();
  });

  app.use(correlationMiddleware);
  app.use(globalRateLimiter);

  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url === "/health",
      },
    }),
  );

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  app.get("/health", (_req, res) => {
    sendSuccess(res, {
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
    });
  });

  app.use("/api/v1", v1Router);

  app.use((_req, _res, next) => {
    next(new NotFoundError("Ruta no encontrada"));
  });

  app.use(errorHandler);

  return app;
};
import rateLimit from "express-rate-limit";
import { env } from "../config/env";

export const globalRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Demasiadas peticiones desde esta IP, por favor inténtalo más tarde.",
  },
  skip: (req) => req.path === "/health" || env.NODE_ENV === "test" || env.NODE_ENV === "development",
});
import type { Response } from "express";

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  errors?: unknown;
}

export const sendSuccess = <T>(
  res: Response,
  data?: T,
  message?: string,
  statusCode = 200,
): Response => {
  const responseBody: ApiResponse<T> = {
    success: true,
    ...(message && { message }),
    ...(data !== undefined && { data }),
  };
  return res.status(statusCode).json(responseBody);
};

export const sendCreated = <T>(res: Response, data?: T, message = "Creado exitosamente"): Response => {
  return sendSuccess(res, data, message, 201);
};
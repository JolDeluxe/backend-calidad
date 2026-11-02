import { describe, it, expect } from "bun:test";
import pino from "pino";

describe("Auditoría de Seguridad y Logging — Redacción de Cabeceras Sensibles", () => {
  it("1. Debe censurar automáticamente authorization y cookie en objetos req", () => {
    let loggedData = "";
    const testStream = {
      write: (chunk: string) => {
        loggedData += chunk;
      },
    };

    const testLogger = pino(
      {
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            'req.headers["x-terminal-credential"]',
            'res.headers["set-cookie"]',
          ],
          censor: "[REDACTED]",
        },
      },
      testStream
    );

    const sensitiveBearer = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token_secreto_super_admin";
    const sensitiveCookie = "auth_session=cookie_secreta_9999999999";
    const sensitiveTerminal = "term_cred_xyz_123456";

    testLogger.info(
      {
        req: {
          method: "GET",
          url: "/api/v1/departamentos/4",
          headers: {
            host: "localhost:3000",
            authorization: sensitiveBearer,
            cookie: sensitiveCookie,
            "x-terminal-credential": sensitiveTerminal,
          },
        },
      },
      "Petición técnica de prueba"
    );

    // 1. Los secretos no deben figurar en el texto plano
    expect(loggedData).not.toContain(sensitiveBearer);
    expect(loggedData).not.toContain(sensitiveCookie);
    expect(loggedData).not.toContain(sensitiveTerminal);

    // 2. Deben haber sido sustituidos por la máscara de censura
    expect(loggedData).toContain("[REDACTED]");
    expect(loggedData).toContain("localhost:3000");
  });

  it("2. Debe censurar set-cookie en objetos res", () => {
    let loggedData = "";
    const testStream = {
      write: (chunk: string) => {
        loggedData += chunk;
      },
    };

    const testLogger = pino(
      {
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            'req.headers["x-terminal-credential"]',
            'res.headers["set-cookie"]',
          ],
          censor: "[REDACTED]",
        },
      },
      testStream
    );

    const sensitiveSetCookie = "auth_session=fresh_session_token_xyz; HttpOnly; Path=/";

    testLogger.info(
      {
        res: {
          statusCode: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": sensitiveSetCookie,
          },
        },
      },
      "Respuesta enviada"
    );

    expect(loggedData).not.toContain(sensitiveSetCookie);
    expect(loggedData).toContain("[REDACTED]");
  });
});

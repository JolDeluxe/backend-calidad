import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { offlineAuthService } from "../src/modules/auth/services/offline-auth.service";
import { lotesCatalogoOfflineService } from "../src/modules/lotes/services/lotes-catalogo-offline.service";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { createHmac } from "node:crypto";
import { env } from "../src/config/env";
import type { Server } from "http";

describe("Fase 1: Infraestructura Offline - Pruebas Unitarias y de Integración", () => {
  let appServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp();
    appServer = app.listen(0);
    const addr = appServer.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (appServer) {
      await new Promise((resolve) => appServer.close(resolve));
    }
  });

  describe("1. Emisión y Validación Criptográfica del Offline Token", () => {
    it("1.1 Emite un token HMAC-SHA256 con vigencia exacta de 48 horas (172,800 segundos)", () => {
      const nowInSeconds = Math.floor(Date.now() / 1000);
      const res = offlineAuthService.generateOfflineToken({
        usuarioId: 10,
        usuario: "inspector_test",
        nombre: "Juan Inspector",
        terminalId: 2,
        terminalNombre: "PC-MONTADO-01",
        departamentoId: 6,
      });

      expect(res.token).toBeDefined();
      expect(typeof res.token).toBe("string");
      expect(res.vigenciaSegundos).toBe(172800);
      expect(res.expiraEn).toBeGreaterThanOrEqual(nowInSeconds + 172795);
      expect(res.expiraEn).toBeLessThanOrEqual(nowInSeconds + 172805);
    });

    it("1.2 Verifica satisfactoriamente un token válido y extrae su estructura", () => {
      const res = offlineAuthService.generateOfflineToken({
        usuarioId: 15,
        usuario: "inspector_calidad",
        nombre: "Maria Control",
        terminalId: 4,
        terminalNombre: "PC-CORTE-02",
        departamentoId: 2,
      });

      const payload = offlineAuthService.verifyOfflineToken(res.token);
      expect(payload.sub).toBe(15);
      expect(payload.usuario).toBe("inspector_calidad");
      expect(payload.nombre).toBe("Maria Control");
      expect(payload.terminalId).toBe(4);
      expect(payload.terminalNombre).toBe("PC-CORTE-02");
      expect(payload.departamentoId).toBe(2);
      expect(payload.tipo).toBe("OFFLINE_CAPTURE");
    });

    it("1.3 Rechaza un token con firma alterada o corrupta", () => {
      const res = offlineAuthService.generateOfflineToken({
        usuarioId: 1,
        usuario: "admin",
        nombre: "Admin",
        terminalId: 1,
        terminalNombre: "PC-ADMIN",
        departamentoId: 1,
      });

      const parts = res.token.split(".");
      const signatureAlterada = parts[2] + "X";
      const tokenManipulado = `${parts[0]}.${parts[1]}.${signatureAlterada}`;

      expect(() => {
        offlineAuthService.verifyOfflineToken(tokenManipulado);
      }).toThrow("Firma del token offline inválida o alterada");
    });

    it("1.4 Rechaza un token con firma generada con un secreto diferente", () => {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT-OFFLINE" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({
        sub: 1,
        usuario: "hacker",
        nombre: "Falso",
        terminalId: 1,
        terminalNombre: "PC-1",
        departamentoId: 1,
        tipo: "OFFLINE_CAPTURE",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 43200,
      })).toString("base64url");

      const signatureInvalida = createHmac("sha256", "SECRETO_INCORRECTO")
        .update(`${header}.${payload}`)
        .digest("base64url");

      const tokenFalso = `${header}.${payload}.${signatureInvalida}`;

      expect(() => {
        offlineAuthService.verifyOfflineToken(tokenFalso);
      }).toThrow("Firma del token offline inválida o alterada");
    });

    it("1.5 Rechaza un token con vigencia expirada", () => {
      const nowInSeconds = Math.floor(Date.now() / 1000);
      const expPasado = nowInSeconds - 60; // Expirado hace 1 minuto

      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT-OFFLINE" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({
        sub: 5,
        usuario: "inspector_exp",
        nombre: "Test Exp",
        terminalId: 1,
        terminalNombre: "PC-1",
        departamentoId: 1,
        tipo: "OFFLINE_CAPTURE",
        iat: nowInSeconds - 43300,
        exp: expPasado,
      })).toString("base64url");

      const signature = createHmac("sha256", env.JWT_SECRET)
        .update(`${header}.${payload}`)
        .digest("base64url");

      const tokenExpirado = `${header}.${payload}.${signature}`;

      expect(() => {
        offlineAuthService.verifyOfflineToken(tokenExpirado);
      }).toThrow("El token de captura offline ha expirado");
    });
  });

  describe("2. Catálogo Offline de Lotes y Sincronización Diferencial", () => {
    it("2.1 Recupera catálogo offline con paginación determinista (keyset cursor)", async () => {
      const res = await lotesCatalogoOfflineService.getCatalogoOffline({
        limit: 10,
        cursor: 0,
      });

      expect(res.items).toBeDefined();
      expect(Array.isArray(res.items)).toBe(true);
      expect(res.totalLote).toBeLessThanOrEqual(10);
      expect(res.servidorTimestamp).toBeDefined();

      if (res.items.length > 0) {
        const item = res.items[0];
        expect(item.id).toBeDefined();
        expect(item.lote).toBeDefined();
        expect(item.modelo).toBeDefined();
        expect(typeof item.cantidad).toBe("number");
        expect(typeof item.activo).toBe("boolean");
        expect(item.actualizadoEn).toBeInstanceOf(Date);
      }
    });

    it("2.2 En carga inicial solo incluye lotes con estado ACTIVO y no eliminados", async () => {
      const res = await lotesCatalogoOfflineService.getCatalogoOffline({
        limit: 50,
      });

      for (const item of res.items) {
        expect(item.activo).toBe(true);
      }
    });

    it("2.3 Sincronización diferencial con parámetro 'desde' incluye marcas de tiempo correspondientes", async () => {
      const fechaCorte = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // 1 año atrás
      const res = await lotesCatalogoOfflineService.getCatalogoOffline({
        desde: fechaCorte,
        limit: 5,
      });

      expect(res.items).toBeDefined();
      for (const item of res.items) {
        expect(item.actualizadoEn.getTime()).toBeGreaterThanOrEqual(fechaCorte.getTime());
      }
    });
  });

  describe("3. Endpoints HTTP de Fase 1", () => {
    it("3.1 GET /api/v1/lotes/catalogo-offline rechaza peticiones sin autenticación (401)", async () => {
      const response = await fetch(`${baseUrl}/api/v1/lotes/catalogo-offline`);
      expect(response.status).toBe(401);
    });

    it("3.2 POST /api/v1/auth/offline-token rechaza peticiones sin autenticación (401)", async () => {
      const response = await fetch(`${baseUrl}/api/v1/auth/offline-token`, {
        method: "POST",
      });
      expect(response.status).toBe(401);
    });
  });
});

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { sessionService } from "../src/modules/auth/services/session.service";
import { securityService } from "../src/modules/auth/services/security.service";
import type { Express } from "express";

describe("Pruebas HTTP End-to-End: Middleware Authenticate, Revocación Real y Seguridad", () => {
  let app: Express;
  let server: any;
  let baseUrl: string;
  let adminId: number;

  beforeAll(async () => {
    app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    const admin = await prisma.usuario.findFirst({
      where: { usuario: "admin" },
    });
    if (!admin) throw new Error("Usuario admin no encontrado");
    adminId = admin.id;
  });

  afterAll(async () => {
    if (server) {
      server.close();
    }
  });

  it("1. Flujo completo: Login HTTP -> Petición protegida HTTP con Bearer token", async () => {
    // A. Login HTTP
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: "admin", password: "Deadmau6" }),
    });

    expect(loginRes.status).toBe(200);
    const loginData = (await loginRes.json()) as any;
    expect(loginData.success).toBe(true);
    expect(loginData.data.accessToken).toBeDefined();

    const cookieHeader = loginRes.headers.get("set-cookie");
    expect(cookieHeader).not.toBeNull();
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("Max-Age=");

    const accessToken = loginData.data.accessToken;

    // B. Petición protegida HTTP a /api/v1/users/roles a través del middleware authenticate
    const protectedRes = await fetch(`${baseUrl}/api/v1/users/roles`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    expect(protectedRes.status).toBe(200);
    const rolesData = (await protectedRes.json()) as any;
    expect(rolesData.success).toBe(true);
    expect(Array.isArray(rolesData.data)).toBe(true);
  });

  it("2. Revocación real de extremo a extremo: si la sesión se revoca en MySQL, la petición HTTP con el access token es rechazada por el middleware con 401", async () => {
    // A. Iniciar sesión y obtener access token
    const login = await sessionService.login(
      { usuario: "admin", password: "Deadmau6" },
      "127.0.0.1",
      "E2E-Agent"
    );

    const token = login.accessToken;
    const decoded = securityService.verifyAccessToken(token);
    expect(decoded?.sesionId).toBeDefined();

    // B. Comprobar que inicialmente la petición HTTP pasa con 200
    const resInicial = await fetch(`${baseUrl}/api/v1/users/roles`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resInicial.status).toBe(200);

    // C. Revocar la sesión en MySQL (por admin o por logout)
    await prisma.sesion.update({
      where: { id: decoded!.sesionId! },
      data: { estado: "INACTIVO" },
    });

    // D. La petición HTTP a la ruta protegida DEBE ser rechazada por el middleware authenticate con 401
    const resPostRevocacion = await fetch(`${baseUrl}/api/v1/users/roles`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(resPostRevocacion.status).toBe(401);
    const errorBody = (await resPostRevocacion.json()) as any;
    expect(errorBody.success).toBe(false);
    expect(errorBody.message).toContain("revocada");

    // Limpieza
    await prisma.sesion.deleteMany({ where: { id: decoded!.sesionId! } });
  });

  it("3. Rechazo estricto de JWT sin sesionId (tokens legados o adulterados)", async () => {
    // Generamos un token válido criptográficamente pero SIN sesionId
    const tokenSinSesion = securityService.generateAccessToken({
      usuarioId: adminId,
      usuario: "admin",
      nombre: "Admin",
      rolId: 1,
      rolCodigo: "SUPER_ADMIN",
    });

    const res = await fetch(`${baseUrl}/api/v1/users/roles`, {
      headers: { Authorization: `Bearer ${tokenSinSesion}` },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.message).toContain("sin identificador de sesión");
  });

  it("4. Rechazo de token adulterado o con firma inválida", async () => {
    const res = await fetch(`${baseUrl}/api/v1/users/roles`, {
      headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.invalidpayload.invalidsig" },
    });

    expect(res.status).toBe(401);
  });

  it("5. Rechazo de petición sin encabezado Authorization", async () => {
    const res = await fetch(`${baseUrl}/api/v1/users/roles`);
    expect(res.status).toBe(401);
  });
});

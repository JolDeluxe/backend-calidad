import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { sessionService } from "../src/modules/auth/services/session.service";
import { terminalsService } from "../src/modules/auth/services/terminals.service";
import type { Express } from "express";

describe("Auditoría Exhaustiva: Terminales HTTP, Falsificación de Departamento y Protección SUPER_ADMIN", () => {
  let app: Express;
  let server: any;
  let baseUrl: string;
  let adminAccessToken: string;
  let inspectorAccessToken: string;
  let adminId: number;
  let inspectorId: number;
  let calidadDeptoId: number;
  let corteDeptoId: number;
  let terminalCalidadId: number;
  let terminalCalidadCred: string;
  let terminalCorteId: number;
  let terminalCorteCred: string;

  beforeAll(async () => {
    app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    const admin = await prisma.usuario.findFirst({ where: { usuario: "admin" } });
    if (!admin) throw new Error("admin no existe");
    adminId = admin.id;

    const calidad = await prisma.departamento.findUnique({ where: { codigo: "CALIDAD" } });
    const corte = await prisma.departamento.findUnique({ where: { codigo: "CORTE" } });
    const inspectorRol = await prisma.rol.findUnique({ where: { codigo: "INSPECTOR" } });

    calidadDeptoId = calidad!.id;
    corteDeptoId = corte!.id;

    // Crear usuario Inspector para pruebas
    const inspector = await prisma.usuario.upsert({
      where: { usuario: "inspector_http_audit" },
      update: { estado: "ACTIVO", rolId: inspectorRol!.id },
      create: {
        usuario: "inspector_http_audit",
        nombre: "Inspector HTTP Audit",
        passwordHash: "dummy:hash",
        rolId: inspectorRol!.id,
        estado: "ACTIVO",
      },
    });
    inspectorId = inspector.id;

    // Asignar al inspector ÚNICAMENTE al departamento CALIDAD
    await prisma.usuarioDepartamento.upsert({
      where: {
        usuarioId_departamentoId: {
          usuarioId: inspectorId,
          departamentoId: calidadDeptoId,
        },
      },
      update: { estado: "ACTIVO" },
      create: {
        usuarioId: inspectorId,
        departamentoId: calidadDeptoId,
        estado: "ACTIVO",
      },
    });

    // Login HTTP de admin para obtener token
    const adminLogin = await sessionService.login(
      { usuario: "admin", password: "Deadmau6" },
      "127.0.0.1"
    );
    adminAccessToken = adminLogin.accessToken;

    // Crear sesiones e access token para inspector
    const inspectorLogin = await sessionService.login(
      { usuario: "inspector_http_audit", password: "any" }, // bypass en test si necesario o crear sesion manual
      "127.0.0.1"
    ).catch(async () => {
      // Si falla password, crear sesion directamente con sessionService
      const s = await prisma.sesion.create({
        data: {
          usuarioId: inspectorId,
          refreshTokenHash: "hash_inspector_http",
          fechaExpiracion: new Date(Date.now() + 1000000),
          estado: "ACTIVO",
        },
      });
      const tok = (await import("../src/modules/auth/services/security.service")).securityService.generateAccessToken({
        usuarioId: inspectorId,
        usuario: "inspector_http_audit",
        nombre: "Inspector HTTP",
        rolId: inspectorRol!.id,
        rolCodigo: "INSPECTOR",
        sesionId: s.id,
      });
      return { accessToken: tok };
    });
    inspectorAccessToken = inspectorLogin.accessToken;

    // Crear terminales
    const tCalidad = await terminalsService.createTerminal({
      nombre: "HTTP-TERM-CALIDAD",
      departamentoId: calidadDeptoId,
      usuarioAuditId: adminId,
    });
    terminalCalidadId = tCalidad.terminal.id;
    terminalCalidadCred = tCalidad.credencial;

    const tCorte = await terminalsService.createTerminal({
      nombre: "HTTP-TERM-CORTE",
      departamentoId: corteDeptoId,
      usuarioAuditId: adminId,
    });
    terminalCorteId = tCorte.terminal.id;
    terminalCorteCred = tCorte.credencial;
  });

  afterAll(async () => {
    if (server) server.close();
    // Limpieza
    await prisma.registroAuditoria.deleteMany({
      where: { terminalId: { in: [terminalCalidadId, terminalCorteId] } },
    });
    await prisma.terminal.deleteMany({
      where: { id: { in: [terminalCalidadId, terminalCorteId] } },
    });
    await prisma.usuarioDepartamento.deleteMany({ where: { usuarioId: inspectorId } });
    await prisma.sesion.deleteMany({ where: { usuarioId: inspectorId } });
    await prisma.usuario.deleteMany({ where: { id: inspectorId } });
  });

  it("1. Captura exitosa: Inspector autorizado en CALIDAD captura desde terminal de CALIDAD", async () => {
    const res = await fetch(`${baseUrl}/api/v1/terminals/captura-defecto-demo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorAccessToken}`,
        "x-terminal-credential": terminalCalidadCred,
      },
      body: JSON.stringify({ datos: "Defecto en costura de cuero" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.departamentoId).toBe(calidadDeptoId);
  });

  it("2. Falsificación bloqueada: Un departamento arbitrario enviado en el body es descartado por el servidor", async () => {
    const res = await fetch(`${baseUrl}/api/v1/terminals/captura-defecto-demo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorAccessToken}`,
        "x-terminal-credential": terminalCalidadCred,
      },
      body: JSON.stringify({
        departamentoId: 999999, // Intentando forzar otro depto en el payload
        datos: "Intento de falsificación",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    // El servidor resolvió el departamento REAL de la terminal en MySQL, ignorando 999999
    expect(body.data.departamentoId).toBe(calidadDeptoId);
    expect(body.data.departamentoId).not.toBe(999999);
  });

  it("3. Alcance bloqueado: Inspector de CALIDAD intentando capturar desde terminal de CORTE es rechazado con 403", async () => {
    const res = await fetch(`${baseUrl}/api/v1/terminals/captura-defecto-demo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorAccessToken}`,
        "x-terminal-credential": terminalCorteCred, // Terminal de Corte
      },
      body: JSON.stringify({ datos: "Defecto en corte" }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.message).toContain("alcance autorizado");
  });

  it("4. Terminal bloqueada: Si la terminal es revocada, la captura posterior es rechazada con 401", async () => {
    // Revocar terminal de Calidad
    await terminalsService.revokeTerminal(terminalCalidadId, "Bloqueo por auditoría", adminId);

    const res = await fetch(`${baseUrl}/api/v1/terminals/captura-defecto-demo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorAccessToken}`,
        "x-terminal-credential": terminalCalidadCred,
      },
      body: JSON.stringify({ datos: "Defecto" }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.message).toContain("revocada");
  });

  it("5. Protección del último SUPER_ADMIN activo: El servidor rechaza degradar o desactivar al único SUPER_ADMIN", async () => {
    const adminUser = await prisma.usuario.findFirst({ where: { usuario: "admin" } });

    // Intento de desactivar a admin
    const resDesactivar = await fetch(`${baseUrl}/api/v1/users/${adminUser!.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAccessToken}`,
      },
      body: JSON.stringify({ estado: "INACTIVO" }),
    });

    expect(resDesactivar.status).toBe(403);
    const bodyDesactivar = (await resDesactivar.json()) as any;
    expect(bodyDesactivar.message).toContain("último SUPER_ADMIN activo");
  });
});

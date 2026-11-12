import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { securityService } from "../src/modules/auth/services/security.service";
import type { Express } from "express";

describe("Blindaje: Autorización Presencial de Super Administrador para Contingencias y Desvinculación", () => {
  let app: Express;
  let server: any;
  let baseUrl: string;

  let superAdminUser: any;
  let superAdminToken: string;
  let inspectorUser: any;
  let inspectorToken: string;
  const superPass = "PruebaSuperPass2026!";

  beforeAll(async () => {
    app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 1. Obtener o crear superadmin de prueba con contraseña conocida
    const rolSuper = await prisma.rol.findUnique({ where: { codigo: "SUPER_ADMIN" } });
    if (!rolSuper) throw new Error("Rol SUPER_ADMIN no encontrado");

    superAdminUser = await prisma.usuario.findFirst({
      where: { usuario: "test_super_auth" },
    });
    if (!superAdminUser) {
      superAdminUser = await prisma.usuario.create({
        data: {
          usuario: "test_super_auth",
          nombre: "Super Admin de Prueba",
          passwordHash: securityService.hashPassword(superPass),
          rolId: rolSuper.id,
          estado: "ACTIVO",
        },
      });
    } else {
      superAdminUser = await prisma.usuario.update({
        where: { id: superAdminUser.id },
        data: { passwordHash: securityService.hashPassword(superPass), estado: "ACTIVO" },
      });
    }

    // 2. Obtener o crear inspector de prueba
    const rolInspector = await prisma.rol.findUnique({ where: { codigo: "INSPECTOR" } });
    if (!rolInspector) throw new Error("Rol INSPECTOR no encontrado");

    inspectorUser = await prisma.usuario.findFirst({
      where: { usuario: "test_insp_auth" },
    });
    if (!inspectorUser) {
      inspectorUser = await prisma.usuario.create({
        data: {
          usuario: "test_insp_auth",
          nombre: "Inspector de Prueba",
          passwordHash: securityService.hashPassword("Inspector123!"),
          rolId: rolInspector.id,
          estado: "ACTIVO",
        },
      });
    } else {
      inspectorUser = await prisma.usuario.update({
        where: { id: inspectorUser.id },
        data: { passwordHash: securityService.hashPassword("Inspector123!"), estado: "ACTIVO" },
      });
    }

    // 3. Login HTTP real para obtener tokens con sesiones activas en BD
    const loginSuper = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: "test_super_auth", password: superPass }),
    });
    const superData = (await loginSuper.json()) as any;
    expect(superData.success).toBe(true);
    superAdminToken = superData.data.accessToken;

    const loginInsp = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: "test_insp_auth", password: "Inspector123!" }),
    });
    const inspData = (await loginInsp.json()) as any;
    expect(inspData.success).toBe(true);
    inspectorToken = inspData.data.accessToken;
  });

  afterAll(async () => {
    if (server) {
      server.close();
    }
  });

  it("1. GET /api/v1/terminales/superadmins devuelve la lista de SuperAdmins activos", async () => {
    const res = await fetch(`${baseUrl}/api/v1/terminales/superadmins`, {
      headers: { Authorization: `Bearer ${inspectorToken}` },
    });
    const data = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.data.length).toBeGreaterThanOrEqual(1);

    const encontrado = data.data.find((sa: any) => sa.id === superAdminUser.id);
    expect(encontrado).toBeDefined();
    expect(encontrado.nombre).toBe(superAdminUser.nombre);
    expect(encontrado.passwordHash).toBeUndefined();
  });

  it("2. POST /api/v1/terminales/verificar-autorizacion-superadmin rechaza contraseña errónea con 401 y audita intento fallido", async () => {
    const res = await fetch(`${baseUrl}/api/v1/terminales/verificar-autorizacion-superadmin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorToken}`,
      },
      body: JSON.stringify({
        superAdminId: superAdminUser.id,
        password: "PasswordCompletamenteIncorrecto",
        accion: "DESVINCULAR_TERMINAL_CON_COLA",
        motivo: "Prueba de rechazo de credencial",
      }),
    });
    const data = (await res.json()) as any;

    expect(res.status).toBe(401);
    expect(data.success).toBe(false);

    // Verificar bitácora de auditoría
    const auditoria = await prisma.registroAuditoria.findFirst({
      where: {
        accion: "AUTORIZACION_SUPERADMIN_FALLIDA",
      },
      orderBy: { id: "desc" },
    });
    expect(auditoria).toBeDefined();
    expect((auditoria?.detalles as any)?.resultado).toBe("RECHAZADO");
  });

  it("3. POST /api/v1/terminales/verificar-autorizacion-superadmin aprueba con contraseña correcta y genera auditoría presencial", async () => {
    const res = await fetch(`${baseUrl}/api/v1/terminales/verificar-autorizacion-superadmin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorToken}`,
      },
      body: JSON.stringify({
        superAdminId: superAdminUser.id,
        password: superPass,
        accion: "IMPORTAR_RESPALDO_OFFLINE_MCBAK",
        motivo: "Restauración de contingencia autorizada en piso",
      }),
    });
    const data = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.autorizado).toBe(true);
    expect(data.data.autorizador.id).toBe(superAdminUser.id);

    // Verificar bitácora de auditoría
    const auditoria = await prisma.registroAuditoria.findFirst({
      where: {
        accion: "AUTORIZACION_SUPERADMIN_PRESENCIAL",
      },
      orderBy: { id: "desc" },
    });
    expect(auditoria).toBeDefined();
    expect((auditoria?.detalles as any)?.resultado).toBe("EXITOSO");
    expect(auditoria?.motivo).toContain("Restauración de contingencia");
    expect(((auditoria?.detalles as any)?.descripcion as string)).toContain("Autorización presencial");
  });
});

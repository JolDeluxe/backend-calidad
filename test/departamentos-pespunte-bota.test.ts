import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../src/config/database";
import { createApp } from "../src/app";
import { securityService } from "../src/modules/auth/services/security.service";
import type { Server } from "node:http";

describe("Validación de Migración y Funcionalidad Departamentos/Defectos", () => {
  let server: Server;
  let port: number;
  let tokenSuperAdmin: string;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        port = (server.address() as any).port;
        baseUrl = `http://127.0.0.1:${port}/api/v1`;
        resolve();
      });
    });

    // 1. Obtener o crear super admin
    let superAdmin = await prisma.usuario.findFirst({
      where: { rol: { codigo: "SUPER_ADMIN" }, estado: "ACTIVO" },
      include: { rol: true },
    });

    if (!superAdmin) {
      const rol = await prisma.rol.upsert({
        where: { codigo: "SUPER_ADMIN" },
        update: { esSistema: true },
        create: { codigo: "SUPER_ADMIN", nombre: "Super Administrador", esSistema: true },
      });

      superAdmin = await prisma.usuario.create({
        data: {
          usuario: `admin_test_mig_${Date.now()}`,
          nombre: "Admin Mig Test",
          passwordHash: securityService.hashPassword("SecureAdminPass123!"),
          rolId: rol.id,
          estado: "ACTIVO",
        },
        include: { rol: true },
      });
    }

    // 2. Crear sesión válida con hash único
    const refreshToken = securityService.generateRefreshToken();
    const sesion = await prisma.sesion.create({
      data: {
        usuarioId: superAdmin.id,
        refreshTokenHash: securityService.hashRefreshToken(refreshToken),
        estado: "ACTIVO",
        fechaExpiracion: new Date(Date.now() + 86400000),
      },
    });

    tokenSuperAdmin = securityService.generateAccessToken({
      usuarioId: superAdmin.id,
      usuario: superAdmin.usuario,
      nombre: superAdmin.nombre,
      rolId: superAdmin.rol.id,
      rolCodigo: superAdmin.rol.codigo,
      sesionId: sesion.id,
    });
  });

  afterAll(async () => {
    if (server) {
      server.close();
    }
  });

  it("1. GET /departamentos/:id debe consultar departamento sin error P2022", async () => {
    // Asegurar existencia de departamento PESPUNTE o crear fixture
    let depto = await prisma.departamento.findUnique({ where: { codigo: "PESPUNTE" } });
    if (!depto) {
      depto = await prisma.departamento.create({
        data: {
          codigo: "PESPUNTE",
          nombre: "Pespunte",
          estado: "ACTIVO",
        },
      });
    }

    const res = await fetch(`${baseUrl}/departamentos/${depto.id}`, {
      headers: {
        Authorization: `Bearer ${tokenSuperAdmin}`,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(depto.id);
    expect(body.data.codigo).toBe("PESPUNTE");
  });

  it("2. PUT /departamentos/:id permite asignar PESPUNTE a la línea BOTA sin error P2022", async () => {
    const depto = await prisma.departamento.findUnique({ where: { codigo: "PESPUNTE" } });
    expect(depto).not.toBeNull();

    // Asegurar línea BOTA
    let tipoProd = await prisma.tipoOperacion.findUnique({ where: { codigo: "PRODUCCION" } });
    if (!tipoProd) {
      tipoProd = await prisma.tipoOperacion.create({
        data: { codigo: "PRODUCCION", nombre: "Producción", estado: "ACTIVO" },
      });
    }

    let lineaBota = await prisma.linea.findFirst({
      where: { codigo: "BOTA", tipoOperacionId: tipoProd.id },
    });
    if (!lineaBota) {
      lineaBota = await prisma.linea.create({
        data: {
          codigo: "BOTA",
          nombre: "Bota",
          tipoOperacionId: tipoProd.id,
          estado: "ACTIVO",
        },
      });
    }

    const res = await fetch(`${baseUrl}/departamentos/${depto!.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenSuperAdmin}`,
      },
      body: JSON.stringify({
        nombre: "Pespunte Operativo",
        lineasIds: [lineaBota.id],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.nombre).toBe("Pespunte Operativo");

    // Verificar en BD la asociación de línea
    const asociacion = await prisma.departamentoLinea.findUnique({
      where: {
        unique_depto_linea: {
          departamentoId: depto!.id,
          lineaId: lineaBota.id,
        },
      },
    });
    expect(asociacion).not.toBeNull();
    expect(asociacion!.activo).toBe(true);
  });
});

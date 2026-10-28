import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { securityService } from "../src/modules/auth/services/security.service";
import type { Express } from "express";

describe("Fase 3 E2E: Protección de la Captura Real Operativa con Terminal Física", () => {
  let app: Express;
  let server: any;
  let baseUrl: string;

  // Tokens de usuarios
  let inspectorToken: string;
  let inspectorUserId: number;
  let superAdminToken: string;
  let adminToken: string;
  let coordToken: string;

  // Entidades maestras
  let deptoMontadoId: number;
  let deptoCorteId: number;
  let terminalActivaMontadoId: number;
  let terminalActivaMontadoCredencial: string;
  let terminalRevocadaId: number;
  let terminalRevocadaCredencial: string;
  let loteCodigo: string;
  let defectoPermitidoMontadoId: number;

  beforeAll(async () => {
    app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Departamentos
    const deptoMontado = await prisma.departamento.findFirst({
      where: { codigo: "MONTADO", estado: "ACTIVO" },
    });
    const deptoCorte = await prisma.departamento.findFirst({
      where: { codigo: "CORTE", estado: "ACTIVO" },
    });
    if (!deptoMontado || !deptoCorte) {
      throw new Error("Departamentos de prueba no encontrados");
    }
    deptoMontadoId = deptoMontado.id;
    deptoCorteId = deptoCorte.id;

    // Login SUPER_ADMIN
    const loginSuper = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: "admin", password: "Deadmau6" }),
    });
    const superData = (await loginSuper.json()) as any;
    superAdminToken = superData.data.accessToken;

    // Crear/actualizar usuarios para prueba
    const passwordHashValida = securityService.hashPassword("TestPass123!");

    // INSPECTOR
    const inspectorRol = await prisma.rol.findUnique({ where: { codigo: "INSPECTOR" } });
    let inspector = await prisma.usuario.findFirst({ where: { usuario: "test_inspector_phase3" } });
    if (!inspector && inspectorRol) {
      inspector = await prisma.usuario.create({
        data: {
          usuario: "test_inspector_phase3",
          nombre: "Inspector Phase 3",
          passwordHash: passwordHashValida,
          rolId: inspectorRol.id,
          estado: "ACTIVO",
        },
      });
    } else if (inspector) {
      await prisma.usuario.update({
        where: { id: inspector.id },
        data: { passwordHash: passwordHashValida, estado: "ACTIVO" },
      });
    }
    inspectorUserId = inspector!.id;

    // ADMIN
    const adminRol = await prisma.rol.findUnique({ where: { codigo: "ADMIN" } });
    let admin = await prisma.usuario.findFirst({ where: { usuario: "test_admin_phase3" } });
    if (!admin && adminRol) {
      admin = await prisma.usuario.create({
        data: {
          usuario: "test_admin_phase3",
          nombre: "Admin Phase 3",
          passwordHash: passwordHashValida,
          rolId: adminRol.id,
          estado: "ACTIVO",
        },
      });
    } else if (admin) {
      await prisma.usuario.update({
        where: { id: admin.id },
        data: { passwordHash: passwordHashValida, estado: "ACTIVO" },
      });
    }

    // COORD
    const coordRol = await prisma.rol.findUnique({ where: { codigo: "COORD" } });
    let coord = await prisma.usuario.findFirst({ where: { usuario: "test_coord_phase3" } });
    if (!coord && coordRol) {
      coord = await prisma.usuario.create({
        data: {
          usuario: "test_coord_phase3",
          nombre: "Coord Phase 3",
          passwordHash: passwordHashValida,
          rolId: coordRol.id,
          estado: "ACTIVO",
        },
      });
    } else if (coord) {
      await prisma.usuario.update({
        where: { id: coord.id },
        data: { passwordHash: passwordHashValida, estado: "ACTIVO" },
      });
    }

    // Logins HTTP para obtener tokens reales con sesiones activas
    const loginInspRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: "test_inspector_phase3", password: "TestPass123!" }),
    });
    inspectorToken = ((await loginInspRes.json()) as any).data.accessToken;

    const loginAdminRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: "test_admin_phase3", password: "TestPass123!" }),
    });
    adminToken = ((await loginAdminRes.json()) as any).data.accessToken;

    const loginCoordRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: "test_coord_phase3", password: "TestPass123!" }),
    });
    coordToken = ((await loginCoordRes.json()) as any).data.accessToken;

    // Crear Terminal Activa asignada a MONTADO
    const resTermActiva = await fetch(`${baseUrl}/api/v1/terminales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({
        nombre: `PC-MONTADO-TEST-${Date.now()}`,
        departamentoId: deptoMontadoId,
      }),
    });
    const dataTermActiva = ((await resTermActiva.json()) as any).data;
    terminalActivaMontadoId = dataTermActiva.terminal.id;
    terminalActivaMontadoCredencial = dataTermActiva.credencial;

    // Crear y Revocar otra Terminal
    const resTermRev = await fetch(`${baseUrl}/api/v1/terminales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({
        nombre: `PC-REVOCADA-TEST-${Date.now()}`,
        departamentoId: deptoCorteId,
      }),
    });
    const dataTermRev = ((await resTermRev.json()) as any).data;
    terminalRevocadaId = dataTermRev.terminal.id;
    terminalRevocadaCredencial = dataTermRev.credencial;

    await fetch(`${baseUrl}/api/v1/terminales/${terminalRevocadaId}/revocar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({ motivo: "Terminal revocada para prueba de rechazo" }),
    });

    // Lote de producción existente
    const loteDb = await prisma.produccionLote.findFirst({
      where: { eliminadoEn: null },
      orderBy: { id: "desc" },
    });
    if (!loteDb) throw new Error("No hay lotes en base de datos para la prueba");
    loteCodigo = loteDb.lote;

    // Defecto permitido en etapa MONTADO
    const etapaMontado = await prisma.defectoEtapa.findFirst({
      where: { departamentoId: deptoMontadoId, permitido: true },
      include: { defecto: true },
    });
    if (!etapaMontado) throw new Error("No hay defecto configurado para la etapa MONTADO");
    defectoPermitidoMontadoId = etapaMontado.defectoId;
  });

  afterAll(async () => {
    if (server) {
      server.close();
    }
  });

  it("1. Captura válida: INSPECTOR captura desde terminal activa y vinculada (201)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/inspecciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorToken}`,
        "x-terminal-credential": terminalActivaMontadoCredencial,
      },
      body: JSON.stringify({
        lote: loteCodigo,
        detalles: [
          {
            defectoId: defectoPermitidoMontadoId,
            paresDefectuosos: 2,
            notas: "Prueba E2E Fase 3 captura válida",
          },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.departamentoAuditoriaId).toBe(deptoMontadoId);
    expect(body.data.terminalId).toBe(terminalActivaMontadoId);
    expect(body.data.inspectorId).toBe(inspectorUserId);
  });

  it("2. Rechazo sin credencial de terminal: POST /inspecciones devuelve 401 Unauthorized", async () => {
    const res = await fetch(`${baseUrl}/api/v1/inspecciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorToken}`,
      },
      body: JSON.stringify({
        lote: loteCodigo,
        detalles: [{ defectoId: defectoPermitidoMontadoId, paresDefectuosos: 1 }],
      }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.message).toContain("Credencial de terminal no proporcionada");
  });

  it("3. Rechazo con credencial inválida: POST /inspecciones devuelve 401 Unauthorized", async () => {
    const res = await fetch(`${baseUrl}/api/v1/inspecciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorToken}`,
        "x-terminal-credential": "credencial_falsa_inventada_123456",
      },
      body: JSON.stringify({
        lote: loteCodigo,
        detalles: [{ defectoId: defectoPermitidoMontadoId, paresDefectuosos: 1 }],
      }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.message).toContain("Terminal inválida, bloqueada o revocada");
  });

  it("4. Rechazo con terminal revocada: POST /inspecciones devuelve 401 Unauthorized", async () => {
    const res = await fetch(`${baseUrl}/api/v1/inspecciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorToken}`,
        "x-terminal-credential": terminalRevocadaCredencial,
      },
      body: JSON.stringify({
        lote: loteCodigo,
        detalles: [{ defectoId: defectoPermitidoMontadoId, paresDefectuosos: 1 }],
      }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.message).toContain("Terminal inválida, bloqueada o revocada");
  });

  it("5. Inviolabilidad departamental: Enviar 'departamentoAuditoriaId' falso en body es ignorado", async () => {
    // La terminal física está vinculada a MONTADO (deptoMontadoId).
    // El cliente malicioso intenta enviar departamentoAuditoriaId = deptoCorteId en el JSON.
    const res = await fetch(`${baseUrl}/api/v1/inspecciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorToken}`,
        "x-terminal-credential": terminalActivaMontadoCredencial,
      },
      body: JSON.stringify({
        lote: loteCodigo,
        departamentoAuditoriaId: deptoCorteId, // Intento de falsificación
        detalles: [
          {
            defectoId: defectoPermitidoMontadoId,
            paresDefectuosos: 1,
            notas: "Intento de fraude departamental",
          },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    // El servidor asigna forzosamente deptoMontadoId de la terminal física
    expect(body.data.departamentoAuditoriaId).toBe(deptoMontadoId);
    expect(body.data.departamentoAuditoriaId).not.toBe(deptoCorteId);
  });

  it("6. Rechazo explícito de captura para SUPER_ADMIN, ADMIN y COORD (403)", async () => {
    // A. Intento con SUPER_ADMIN
    const resSuper = await fetch(`${baseUrl}/api/v1/inspecciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${superAdminToken}`,
        "x-terminal-credential": terminalActivaMontadoCredencial,
      },
      body: JSON.stringify({
        lote: loteCodigo,
        detalles: [{ defectoId: defectoPermitidoMontadoId, paresDefectuosos: 1 }],
      }),
    });
    expect(resSuper.status).toBe(403);

    // B. Intento con ADMIN
    const resAdmin = await fetch(`${baseUrl}/api/v1/inspecciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
        "x-terminal-credential": terminalActivaMontadoCredencial,
      },
      body: JSON.stringify({
        lote: loteCodigo,
        detalles: [{ defectoId: defectoPermitidoMontadoId, paresDefectuosos: 1 }],
      }),
    });
    expect(resAdmin.status).toBe(403);

    // C. Intento con COORD
    const resCoord = await fetch(`${baseUrl}/api/v1/inspecciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${coordToken}`,
        "x-terminal-credential": terminalActivaMontadoCredencial,
      },
      body: JSON.stringify({
        lote: loteCodigo,
        detalles: [{ defectoId: defectoPermitidoMontadoId, paresDefectuosos: 1 }],
      }),
    });
    expect(resCoord.status).toBe(403);
  });

  it("7. INSPECTOR captura en terminal física sin estar previamente asignado a ese departamento", async () => {
    // El inspector 'test_inspector_phase3' no tiene relación en usuario_departamentos para MONTADO.
    // La regla de negocio indica que la estación física fija el departamento operativo.
    const res = await fetch(`${baseUrl}/api/v1/inspecciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorToken}`,
        "x-terminal-credential": terminalActivaMontadoCredencial,
      },
      body: JSON.stringify({
        lote: loteCodigo,
        detalles: [
          {
            defectoId: defectoPermitidoMontadoId,
            paresDefectuosos: 3,
            notas: "Inspector móvil en estación física",
          },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.departamentoAuditoriaId).toBe(deptoMontadoId);
  });

  it("8. Atomicidad y rollback: Un fallo en detalle no deja registros huérfanos en cabecera", async () => {
    const totalCabecerasAntes = await prisma.inspeccionCabecera.count();

    // Intentamos registrar con un defectoId inexistente (provocará error 400 antes de commit)
    const resFallo = await fetch(`${baseUrl}/api/v1/inspecciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorToken}`,
        "x-terminal-credential": terminalActivaMontadoCredencial,
      },
      body: JSON.stringify({
        lote: loteCodigo,
        detalles: [
          {
            defectoId: 999999, // Defecto inexistente
            paresDefectuosos: 1,
          },
        ],
      }),
    });

    expect(resFallo.status).toBe(400);

    const totalCabecerasDespues = await prisma.inspeccionCabecera.count();
    expect(totalCabecerasDespues).toBe(totalCabecerasAntes); // Rollback garantizado
  });
});

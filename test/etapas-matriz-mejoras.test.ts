import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { securityService } from "../src/modules/auth/services/security.service";
import type { Server } from "http";

describe("Mejoras de Etapas, Matriz de Defectos y Validación Estricta de Inspecciones", () => {
  let appServer: Server;
  let baseUrl: string;
  let adminToken: string;
  let adminUser: any;
  let inspectorUser: any;
  let inspectorToken: string;
  let defectoTestId: number;
  let loteTestId: number;

  beforeAll(async () => {
    const app = createApp();
    appServer = app.listen(0);
    const port = (appServer.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}/api/v1`;

    adminUser = await prisma.usuario.findFirst({
      where: { usuario: "admin" },
      include: { rol: true },
    });
    if (!adminUser) throw new Error("Usuario admin no encontrado");

    const sesionAdmin = await prisma.sesion.create({
      data: {
        usuarioId: adminUser.id,
        refreshTokenHash: `hash_admin_etapas_${Date.now()}_${Math.random()}`,
        fechaExpiracion: new Date(Date.now() + 3600000),
      },
    });

    adminToken = securityService.generateAccessToken({
      usuarioId: adminUser.id,
      usuario: adminUser.usuario,
      nombre: adminUser.nombre,
      rolId: adminUser.rolId,
      rolCodigo: adminUser.rol.codigo,
      sesionId: sesionAdmin.id,
    });

    const inspRol = await prisma.rol.findFirst({ where: { codigo: "INSPECTOR" } });
    const deptoCorte = await prisma.departamento.findFirst({ where: { codigo: "CORTE" } });

    inspectorUser = await prisma.usuario.create({
      data: {
        usuario: `insp_test_${Date.now()}`,
        nombre: "Inspector Test Etapas",
        passwordHash: "hash_test_dummy",
        rolId: inspRol!.id,
        estado: "ACTIVO",
      },
      include: { rol: true },
    });

    await prisma.usuarioDepartamento.create({
      data: {
        usuarioId: inspectorUser.id,
        departamentoId: deptoCorte!.id,
        estado: "ACTIVO",
      },
    });

    const sesionInsp = await prisma.sesion.create({
      data: {
        usuarioId: inspectorUser.id,
        refreshTokenHash: `hash_insp_etapas_${Date.now()}_${Math.random()}`,
        fechaExpiracion: new Date(Date.now() + 3600000),
      },
    });

    inspectorToken = securityService.generateAccessToken({
      usuarioId: inspectorUser.id,
      usuario: inspectorUser.usuario,
      nombre: inspectorUser.nombre,
      rolId: inspectorUser.rolId,
      rolCodigo: inspectorUser.rol.codigo,
      sesionId: sesionInsp.id,
    });

    // Lote de prueba aislado
    const lote = await prisma.produccionLote.create({
      data: {
        lote: "LOTE_TEST_ETAPAS",
        listaLote: "TEST-01",
        lista: "TEST",
        idProducto: "PROD-TEST",
        modelo: "MOD-01",
        cantidad: 10,
        cliente: "CLIENTE TEST",
      },
    });
    loteTestId = lote.id;
  });

  afterAll(async () => {
    // Limpieza obligatoria y completa de todos los datos de prueba
    if (defectoTestId) {
      await prisma.inspeccionDetalle.deleteMany({ where: { defectoId: defectoTestId } });
      await prisma.defectoEtapa.deleteMany({ where: { defectoId: defectoTestId } });
      await prisma.defectoDepartamento.deleteMany({ where: { defectoId: defectoTestId } });
      await prisma.defecto.deleteMany({ where: { id: defectoTestId } });
    }

    if (loteTestId) {
      const cabeceras = await prisma.inspeccionCabecera.findMany({ where: { loteId: loteTestId } });
      for (const c of cabeceras) {
        await prisma.inspeccionDetalle.deleteMany({ where: { inspeccionId: c.id } });
      }
      await prisma.inspeccionCabecera.deleteMany({ where: { loteId: loteTestId } });
      await prisma.produccionLote.delete({ where: { id: loteTestId } });
    }

    if (inspectorUser) {
      await prisma.sesion.deleteMany({ where: { usuarioId: inspectorUser.id } });
      await prisma.usuarioDepartamento.deleteMany({ where: { usuarioId: inspectorUser.id } });
      await prisma.usuario.delete({ where: { id: inspectorUser.id } });
    }

    if (adminUser) {
      await prisma.sesion.deleteMany({
        where: { usuarioId: adminUser.id, refreshTokenHash: { startsWith: "hash_admin_etapas_" } },
      });
    }

    appServer.close();
  });

  it("1. Rechaza la creación de un defecto sin departamento propietario explícito", async () => {
    const res = await fetch(`${baseUrl}/defectos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        defecto: "Defecto sin depto propietario",
        clasificacion: "MENOR",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
  });

  it("2. Crea un defecto con departamento propietario y devuelve datos correctos", async () => {
    const deptoCorte = await prisma.departamento.findFirst({ where: { codigo: "CORTE" } });

    const res = await fetch(`${baseUrl}/defectos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        defecto: "Defecto de prueba con propietario corte",
        clasificacion: "MENOR",
        departamentoId: deptoCorte!.id,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.id).toBeDefined();
    expect(body.data.departamentoId).toBe(deptoCorte!.id);
    defectoTestId = body.data.id;
  });

  it("3. Actualiza la matriz de etapas permitidas/bloqueadas mediante PUT /defectos/:id/etapas", async () => {
    const deptoCorte = await prisma.departamento.findFirst({ where: { codigo: "CORTE" } });
    const deptoAcabado = await prisma.departamento.findFirst({ where: { codigo: "ACABADO" } });

    const putRes = await fetch(`${baseUrl}/defectos/${defectoTestId}/etapas`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        etapas: [
          { departamentoId: deptoCorte!.id, permitido: false },
          { departamentoId: deptoAcabado!.id, permitido: true },
        ],
      }),
    });

    expect(putRes.status).toBe(200);
    const body = (await putRes.json()) as any;
    expect(body.success).toBe(true);

    // Verificar persistencia en base de datos
    const etapas = await prisma.defectoEtapa.findMany({ where: { defectoId: defectoTestId } });
    const cortePermiso = etapas.find((e) => e.departamentoId === deptoCorte!.id);
    const acabadoPermiso = etapas.find((e) => e.departamentoId === deptoAcabado!.id);

    expect(cortePermiso?.permitido).toBe(false);
    expect(acabadoPermiso?.permitido).toBe(true);
  });

  it("4. Inspección rechaza un defecto cuyo permiso para la etapa es falso (bloqueado)", async () => {
    const deptoCorte = await prisma.departamento.findFirst({ where: { codigo: "CORTE" } });
    const lineaBota = await prisma.linea.findFirst({ where: { codigo: "BOTA" } });

    const res = await fetch(`${baseUrl}/inspecciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorToken}`,
      },
      body: JSON.stringify({
        lote: "LOTE_TEST_ETAPAS",
        departamentoAuditoriaId: deptoCorte!.id,
        lineaId: lineaBota!.id,
        detalles: [
          {
            defectoId: defectoTestId,
            paresDefectuosos: 1,
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.message).toContain("no está permitido para inspección en la etapa");
  });

  it("5. Inspección rechaza un defecto que NO tiene relación configurada en la matriz (whitelist estricta)", async () => {
    const deptoMontado = await prisma.departamento.findFirst({ where: { codigo: "MONTADO" } });
    const lineaBota = await prisma.linea.findFirst({ where: { codigo: "BOTA" } });

    const res = await fetch(`${baseUrl}/inspecciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorToken}`,
      },
      body: JSON.stringify({
        lote: "LOTE_TEST_ETAPAS",
        departamentoAuditoriaId: deptoMontado!.id,
        lineaId: lineaBota!.id,
        detalles: [
          {
            defectoId: defectoTestId, // No tiene relación con Montado
            paresDefectuosos: 1,
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.message).toContain("no está permitido para inspección en la etapa");
  });

  it("6. Inspección rechaza una etapa que no pertenece a la línea seleccionada", async () => {
    const deptoCintos = await prisma.departamento.findFirst({ where: { codigo: "CINTOS" } });
    const lineaBota = await prisma.linea.findFirst({ where: { codigo: "BOTA" } });

    if (deptoCintos && lineaBota) {
      const res = await fetch(`${baseUrl}/inspecciones`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${inspectorToken}`,
        },
        body: JSON.stringify({
          lote: "LOTE_TEST_ETAPAS",
          departamentoAuditoriaId: deptoCintos.id,
          lineaId: lineaBota.id,
          detalles: [
            {
              defectoId: defectoTestId,
              paresDefectuosos: 1,
            },
          ],
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.message).toContain("no está asignado o no está activo en la línea");
    }
  });

  it("7. Devuelve las etapas de una línea ordenadas por su secuencia configurada en BD", async () => {
    const lineaBota = await prisma.linea.findFirst({
      where: { codigo: "BOTA" },
      include: {
        departamentos: {
          where: { activo: true, eliminadoEn: null },
          orderBy: { orden: "asc" },
          include: { departamento: true },
        },
      },
    });

    expect(lineaBota).toBeDefined();
    expect(lineaBota!.departamentos.length).toBeGreaterThanOrEqual(8);

    const ordenes = lineaBota!.departamentos.map((d) => d.orden);
    for (let i = 0; i < ordenes.length - 1; i++) {
      expect(ordenes[i]).toBeLessThanOrEqual(ordenes[i + 1]);
    }
  });
});

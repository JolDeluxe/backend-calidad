import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { securityService } from "../src/modules/auth/services/security.service";
import {
  getRangoDiaUtc,
  getRangoSemanaIsoUtc,
  getRangoMesUtc,
  getRangoAnioUtc,
  getIsoYearAndWeek,
  getMaxSemanasIsoEnAnio,
  esFechaIsoValida,
  getHoyMexicoStr,
  getPartesFechaMexico,
} from "../src/utils/timezone";
import type { Express } from "express";

/**
 * Fase 2 — Pruebas de Segmentación Temporal Avanzada, Periodos Disponibles,
 * Inspectores Activos, Permisos Departamentales, Zona Horaria America/Mexico_City y Exportación.
 */
describe("Fase 2 Backend: Segmentación temporal, periodos disponibles, inspectores activos y exportación", () => {
  let app: Express;
  let server: any;
  let baseUrl: string;

  const tokens: Record<string, string> = {};
  const usuariosCreadosIds: number[] = [];
  const inspeccionesCreadasIds: number[] = [];

  let deptoMontadoId: number;
  let deptoCorteId: number;
  let loteId: number;
  let defectoId: number;

  let inspectorActivoMontadoId: number;
  let inspectorActivoCorteId: number;
  let inspectorInactivoId: number;
  let coordRestringidoMontadoId: number;
  let adminGeneralId: number;

  let inspCruceIso2024Id: number; // 2024-12-30 10:00 America/Mexico_City (ISO 2025-W01)
  let inspNocheLocalId: number;   // 2025-06-15 20:30 America/Mexico_City (2025-06-16T02:30:00.000Z)
  let inspFinDiaMsId: number;     // 2025-06-15 23:59:59.999 America/Mexico_City (2025-06-16T05:59:59.999Z)
  let inspInactivoHistId: number; // Inspección histórica registrada por inspector hoy INACTIVO
  let inspEliminadaId: number;    // Inspección con detalle eliminado lógicamente
  let detalleEliminadoId: number;

  const api = async (
    method: string,
    path: string,
    who: string | null,
    body?: unknown,
    extra: Record<string, string> = {}
  ) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...extra };
    if (who) headers.Authorization = `Bearer ${tokens[who]}`;
    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    return { status: res.status, json, headers: res.headers };
  };

  const crearUsuarioPrueba = async (
    usuario: string,
    rolCodigo: string,
    estado: "ACTIVO" | "INACTIVO" = "ACTIVO",
    departamentosIds: number[] = []
  ) => {
    const rol = await prisma.rol.findUnique({ where: { codigo: rolCodigo } });
    if (!rol) throw new Error(`Rol ${rolCodigo} no encontrado`);
    const passwordHash = securityService.hashPassword("TestPass123!");

    const existente = await prisma.usuario.findFirst({ where: { usuario } });
    if (existente) {
      await prisma.usuarioDepartamento.deleteMany({ where: { usuarioId: existente.id } });
      await prisma.usuario.delete({ where: { id: existente.id } }).catch(() => {});
    }

    const u = await prisma.usuario.create({
      data: {
        usuario,
        nombre: `Nombre ${usuario}`,
        passwordHash,
        rolId: rol.id,
        estado: "ACTIVO",
        departamentos:
          departamentosIds.length > 0
            ? {
                create: departamentosIds.map((dId) => ({
                  departamentoId: dId,
                })),
              }
            : undefined,
      },
    });
    usuariosCreadosIds.push(u.id);

    let token = "";
    const login = await api("POST", "/auth/login", null, { usuario, password: "TestPass123!" });
    if (login.status === 200) {
      token = login.json.data.accessToken as string;
    }

    if (estado === "INACTIVO") {
      await prisma.usuario.update({ where: { id: u.id }, data: { estado: "INACTIVO" } });
    }

    return { id: u.id, token };
  };

  beforeAll(async () => {
    app = createApp();
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const montado = await prisma.departamento.findFirst({ where: { codigo: "MONTADO", estado: "ACTIVO" } });
    const corte = await prisma.departamento.findFirst({ where: { codigo: "CORTE", estado: "ACTIVO" } });
    if (!montado || !corte) throw new Error("Departamentos MONTADO y CORTE requeridos para pruebas");
    deptoMontadoId = montado.id;
    deptoCorteId = corte.id;

    const l = await prisma.produccionLote.findFirst({
      where: { estado: "ACTIVO", eliminadoEn: null },
      orderBy: { id: "desc" },
    });
    if (!l) throw new Error("Lote activo requerido para pruebas");
    loteId = l.id;

    const def = await prisma.defecto.findFirst({
      where: { activo: true, eliminadoEn: null },
      orderBy: { id: "asc" },
    });
    if (!def) throw new Error("Defecto activo requerido para pruebas");
    defectoId = def.id;

    // Limpiar restos previos si alguna corrida anterior se interrumpió
    const prevCabeceras = await prisma.inspeccionCabecera.findMany({
      where: { folio: { startsWith: "F2-" } },
      select: { id: true },
    });
    if (prevCabeceras.length > 0) {
      const prevIds = prevCabeceras.map((c) => c.id);
      await prisma.inspeccionDetalle.deleteMany({ where: { inspeccionId: { in: prevIds } } });
      await prisma.inspeccionCabecera.deleteMany({ where: { id: { in: prevIds } } });
    }
    const prevUsers = await prisma.usuario.findMany({
      where: { usuario: { startsWith: "f2_" } },
      select: { id: true },
    });
    if (prevUsers.length > 0) {
      const prevUIds = prevUsers.map((u) => u.id);
      await prisma.usuarioDepartamento.deleteMany({ where: { usuarioId: { in: prevUIds } } });
      await prisma.usuario.deleteMany({ where: { id: { in: prevUIds } } });
    }

    const suf = Date.now();
    const uInspMontado = await crearUsuarioPrueba(`f2_insp_mont_${suf}`, "INSPECTOR", "ACTIVO", [deptoMontadoId]);
    inspectorActivoMontadoId = uInspMontado.id;
    tokens.inspMontado = uInspMontado.token;

    const uInspCorte = await crearUsuarioPrueba(`f2_insp_corte_${suf}`, "INSPECTOR", "ACTIVO", [deptoCorteId]);
    inspectorActivoCorteId = uInspCorte.id;
    tokens.inspCorte = uInspCorte.token;

    const uInspInactivo = await crearUsuarioPrueba(`f2_insp_inact_${suf}`, "INSPECTOR", "INACTIVO", [deptoMontadoId]);
    inspectorInactivoId = uInspInactivo.id;

    const uCoordMontado = await crearUsuarioPrueba(`f2_coord_mont_${suf}`, "COORD", "ACTIVO", [deptoMontadoId]);
    coordRestringidoMontadoId = uCoordMontado.id;
    tokens.coordMontado = uCoordMontado.token;

    const uSuperAdmin = await crearUsuarioPrueba(`f2_superadmin_${suf}`, "SUPER_ADMIN", "ACTIVO", []);
    tokens.superadmin = uSuperAdmin.token;

    const uAdminGen = await crearUsuarioPrueba(`f2_admin_gen_${suf}`, "ADMIN", "ACTIVO", []);
    adminGeneralId = uAdminGen.id;
    tokens.admin = uAdminGen.token;

    // 1. Inspección en cruce de año ISO: Lunes 30 de diciembre de 2024 a las 10:00 America/Mexico_City (16:00 UTC)
    // Pertenece al año calendario 2024, pero a la Semana ISO 1 del año ISO 2025 (2025-W01).
    const c1 = await prisma.inspeccionCabecera.create({
      data: {
        folio: `F2-ISO2025W01-${suf}`,
        loteId,
        inspectorId: inspectorActivoMontadoId,
        departamentoAuditoriaId: deptoMontadoId,
        fechaInspeccion: new Date("2024-12-30T16:00:00.000Z"),
        estado: "RECHAZADO",
        detalles: {
          create: [
            { defectoId, defDeptoId: deptoMontadoId, paresDefectuosos: 2 },
            { defectoId, defDeptoId: deptoMontadoId, paresDefectuosos: 1 },
          ],
        },
      },
    });
    inspCruceIso2024Id = c1.id;
    inspeccionesCreadasIds.push(c1.id);

    // 2. Inspección nocturna en America/Mexico_City:
    // 2025-06-15 a las 20:30 local -> 2025-06-16T02:30:00.000Z en UTC.
    // En UTC ya es 16 de junio, pero en America/Mexico_City sigue siendo 15 de junio.
    const c2 = await prisma.inspeccionCabecera.create({
      data: {
        folio: `F2-NOCHE-${suf}`,
        loteId,
        inspectorId: inspectorActivoMontadoId,
        departamentoAuditoriaId: deptoMontadoId,
        fechaInspeccion: new Date("2025-06-16T02:30:00.000Z"),
        estado: "RECHAZADO",
        detalles: {
          create: [{ defectoId, defDeptoId: deptoMontadoId, paresDefectuosos: 3 }],
        },
      },
    });
    inspNocheLocalId = c2.id;
    inspeccionesCreadasIds.push(c2.id);

    // 3. Inspección en el último milisegundo del 2025-06-15 en America/Mexico_City:
    // 2025-06-15 23:59:59.999 local -> 2025-06-16T05:59:59.999Z en UTC.
    const c3 = await prisma.inspeccionCabecera.create({
      data: {
        folio: `F2-FINDIA-MS-${suf}`,
        loteId,
        inspectorId: inspectorActivoMontadoId,
        departamentoAuditoriaId: deptoMontadoId,
        fechaInspeccion: new Date("2025-06-16T05:59:59.999Z"),
        estado: "RECHAZADO",
        detalles: {
          create: [{ defectoId, defDeptoId: deptoMontadoId, paresDefectuosos: 1 }],
        },
      },
    });
    inspFinDiaMsId = c3.id;
    inspeccionesCreadasIds.push(c3.id);

    // 4. Inspección histórica de un inspector que actualmente está INACTIVO (en depto CORTE):
    const c4 = await prisma.inspeccionCabecera.create({
      data: {
        folio: `F2-INACT-HIST-${suf}`,
        loteId,
        inspectorId: inspectorInactivoId,
        departamentoAuditoriaId: deptoCorteId,
        fechaInspeccion: new Date("2025-06-15T15:00:00.000Z"),
        estado: "RECHAZADO",
        detalles: {
          create: [{ defectoId, defDeptoId: deptoCorteId, paresDefectuosos: 4 }],
        },
      },
    });
    inspInactivoHistId = c4.id;
    inspeccionesCreadasIds.push(c4.id);

    // 5. Inspección con defecto eliminado lógicamente en una fecha exclusiva (2024-03-10 local):
    const c5 = await prisma.inspeccionCabecera.create({
      data: {
        folio: `F2-ELIM-${suf}`,
        loteId,
        inspectorId: inspectorActivoMontadoId,
        departamentoAuditoriaId: deptoMontadoId,
        fechaInspeccion: new Date("2024-03-10T18:00:00.000Z"),
        estado: "RECHAZADO",
        detalles: {
          create: [
            {
              defectoId,
              defDeptoId: deptoMontadoId,
              paresDefectuosos: 2,
              eliminadoEn: new Date(),
              eliminadoPor: adminGeneralId,
              eliminadoMotivo: "Prueba Fase 2 borrado lógico",
            },
          ],
        },
      },
      include: { detalles: true },
    });
    inspEliminadaId = c5.id;
    detalleEliminadoId = c5.detalles[0]!.id;
    inspeccionesCreadasIds.push(c5.id);
  });

  afterAll(async () => {
    try {
      if (inspeccionesCreadasIds.length > 0) {
        await prisma.inspeccionDetalle.deleteMany({
          where: { inspeccionId: { in: inspeccionesCreadasIds } },
        });
        await prisma.inspeccionCabecera.deleteMany({
          where: { id: { in: inspeccionesCreadasIds } },
        });
      }
      if (usuariosCreadosIds.length > 0) {
        await prisma.usuarioDepartamento.deleteMany({
          where: { usuarioId: { in: usuariosCreadosIds } },
        });
        await prisma.usuario.deleteMany({
          where: { id: { in: usuariosCreadosIds } },
        });
      }
    } finally {
      server?.close();
    }
  });

  // =========================================================================
  // 1. ZONA HORARIA (America/Mexico_City) E INTERVALOS SEMIABIERTOS [gte, lt)
  // =========================================================================
  describe("1. Conversión de límites horarios en America/Mexico_City e intervalos semiabiertos", () => {
    it("1.1. Calcula límites exactos de día en America/Mexico_City [06:00:00.000Z, +1d 06:00:00.000Z)", () => {
      const { inicioUtc, finUtc } = getRangoDiaUtc("2025-06-15");
      expect(inicioUtc.toISOString()).toBe("2025-06-15T06:00:00.000Z");
      expect(finUtc.toISOString()).toBe("2025-06-16T06:00:00.000Z");
    });

    it("1.2. Calcula límites de mes y año bisiesto sin perder milisegundos", () => {
      const feb2024 = getRangoMesUtc(2024, 2);
      expect(feb2024.inicioUtc.toISOString()).toBe("2024-02-01T06:00:00.000Z");
      expect(feb2024.finUtc.toISOString()).toBe("2024-03-01T06:00:00.000Z");

      const anio2025 = getRangoAnioUtc(2025);
      expect(anio2025.inicioUtc.toISOString()).toBe("2025-01-01T06:00:00.000Z");
      expect(anio2025.finUtc.toISOString()).toBe("2026-01-01T06:00:00.000Z");
    });

    it("1.3. Incluye capturas realizadas a las 20:30 local y a las 23:59:59.999 local dentro del mismo día operativo", async () => {
      const rDia15 = await api("GET", "/inspecciones?periodo=dia&dia=2025-06-15&limit=200", "admin");
      expect(rDia15.status).toBe(200);
      const idsDia15 = new Set(rDia15.json.data.items.map((i: any) => i.inspeccionId));
      // Ambas ocurrieron el 16 de junio en UTC (02:30Z y 05:59:59.999Z), pero el 15 de junio en America/Mexico_City
      expect(idsDia15.has(inspNocheLocalId)).toBe(true);
      expect(idsDia15.has(inspFinDiaMsId)).toBe(true);

      // Y NO deben contaminar el día siguiente (2025-06-16 en America/Mexico_City)
      const rDia16 = await api("GET", "/inspecciones?periodo=dia&dia=2025-06-16&limit=200", "admin");
      expect(rDia16.status).toBe(200);
      const idsDia16 = new Set(rDia16.json.data.items.map((i: any) => i.inspeccionId));
      expect(idsDia16.has(inspNocheLocalId)).toBe(false);
      expect(idsDia16.has(inspFinDiaMsId)).toBe(false);
    });
  });

  // =========================================================================
  // 2. SEMANAS ISO 8601 Y CRUCES DE AÑO
  // =========================================================================
  describe("2. Semanas ISO 8601 (lunes a domingo) y cruces de año", () => {
    it("2.1. Identifica correctamente cruces de año en ISO 8601 (ej. 2024-12-30 -> 2025-W01 y 2026 con 53 semanas)", () => {
      const isoCruce = getIsoYearAndWeek("2024-12-30");
      expect(isoCruce.anioIso).toBe(2025);
      expect(isoCruce.semanaIso).toBe(1);

      expect(getMaxSemanasIsoEnAnio(2025)).toBe(52);
      expect(getMaxSemanasIsoEnAnio(2026)).toBe(53);

      const sem1_2025 = getRangoSemanaIsoUtc(2025, 1);
      expect(sem1_2025.fechaInicio).toBe("2024-12-30");
      expect(sem1_2025.fechaFin).toBe("2025-01-05");
      expect(sem1_2025.inicioUtc.toISOString()).toBe("2024-12-30T06:00:00.000Z");
      expect(sem1_2025.finUtc.toISOString()).toBe("2025-01-06T06:00:00.000Z");
    });

    it("2.2. Consulta registros de una semana ISO que cruza de año (anioIso=2025, semana=1 incluye el 30 dic 2024)", async () => {
      const r = await api(
        "GET",
        `/inspecciones?periodo=semana&anioIso=2025&semana=1&inspectorId=${inspectorActivoMontadoId}`,
        "admin"
      );
      expect(r.status).toBe(200);
      const ids = new Set(r.json.data.items.map((i: any) => i.inspeccionId));
      expect(ids.has(inspCruceIso2024Id)).toBe(true);
      // Esa inspección tiene 2 detalles registrados en la misma cabecera
      expect(r.json.data.totalDefectos).toBe(2);
      expect(r.json.data.totalInspecciones).toBe(1);
    });
  });

  // =========================================================================
  // 3. PERIODOS DISPONIBLES (AÑOS, MESES, SEMANAS ISO Y DÍAS CON REGISTROS REALES)
  // =========================================================================
  describe("3. Periodos disponibles con registros reales", () => {
    it("3.1. Devuelve únicamente años, años ISO, meses, semanas ISO y días con registros reales (> 0) y no futuros", async () => {
      const r = await api(
        "GET",
        `/inspecciones/periodos-disponibles?inspectorId=${inspectorActivoMontadoId}&anio=2024&anioIso=2025&mes=12&semana=1`,
        "admin"
      );
      expect(r.status).toBe(200);
      const data = r.json.data;

      // Debe incluir el año calendario 2024 y 2025 (donde inspectorActivoMontadoId tiene capturas activas)
      const aniosList = data.anios.map((a: any) => a.anio);
      expect(aniosList).toContain(2024);
      expect(aniosList).toContain(2025);
      for (const a of data.anios) {
        expect(a.totalDefectos).toBeGreaterThan(0);
        expect(a.totalInspecciones).toBeGreaterThan(0);
      }

      // Debe incluir el año ISO 2025 (por la captura del 2024-12-30 que cae en 2025-W01)
      const aniosIsoList = data.aniosIso.map((a: any) => a.anioIso);
      expect(aniosIsoList).toContain(2025);

      // Meses de 2024 para este inspector: solo diciembre (12) porque el de marzo (3) está eliminado lógicamente
      const meses2024 = data.meses.map((m: any) => m.mes);
      expect(meses2024).toEqual([12]);

      // Semanas ISO de anioIso=2025: incluye semana 1 (2024-12-30 al 2025-01-05) y semana 24 (2025-06-15)
      const sem1 = data.semanas.find((s: any) => s.anioIso === 2025 && s.semana === 1);
      expect(sem1).toBeDefined();
      expect(sem1.fechaInicio).toBe("2024-12-30");
      expect(sem1.fechaFin).toBe("2025-01-05");
      expect(sem1.codigo).toBe("2025-W01");
      expect(sem1.etiqueta).toContain("Semana 01 (30 dic. 2024 – 5 ene. 2025)");

      // Días dentro de 2025-W01 para este inspector: únicamente 2024-12-30
      expect(data.dias.map((d: any) => d.fecha)).toEqual(["2024-12-30"]);
    });

    it("3.2. No devuelve días ni periodos donde los únicos registros fueron eliminados lógicamente (salvo soloEliminados=true)", async () => {
      // Con soloEliminados=false (por defecto), marzo 2024 no aparece para inspectorActivoMontadoId
      const rActivos = await api(
        "GET",
        `/inspecciones/periodos-disponibles?inspectorId=${inspectorActivoMontadoId}&anio=2024&mes=3`,
        "admin"
      );
      expect(rActivos.status).toBe(200);
      expect(rActivos.json.data.dias.length).toBe(0);

      // Con soloEliminados=true sin permiso defectos.eliminar (admin normal) -> 403 Forbidden
      const rElimSinPermiso = await api(
        "GET",
        `/inspecciones/periodos-disponibles?inspectorId=${inspectorActivoMontadoId}&anio=2024&mes=3&soloEliminados=true`,
        "admin"
      );
      expect(rElimSinPermiso.status).toBe(403);

      // Con soloEliminados=true y permiso defectos.eliminar (superadmin), marzo 2024 (2024-03-10) sí aparece
      const rElim = await api(
        "GET",
        `/inspecciones/periodos-disponibles?inspectorId=${inspectorActivoMontadoId}&anio=2024&mes=3&soloEliminados=true`,
        "superadmin"
      );
      expect(rElim.status).toBe(200);
      expect(rElim.json.data.dias.map((d: any) => d.fecha)).toEqual(["2024-03-10"]);
    });
  });

  // =========================================================================
  // 4. INSPECTORES ACTIVOS E HISTORIAL DE INACTIVOS
  // =========================================================================
  describe("4. Inspectores activos y preservación de historial de inactivos", () => {
    it("4.1. GET /inspecciones/inspectores devuelve exclusivamente usuarios con rol INSPECTOR y estado ACTIVO", async () => {
      const r = await api("GET", "/inspecciones/inspectores", "admin");
      expect(r.status).toBe(200);
      const lista = r.json.data as Array<{ id: number; usuario: string; nombre: string; departamentosIds: number[] }>;
      expect(lista.length).toBeGreaterThan(0);

      const idsDevueltos = new Set(lista.map((u) => u.id));
      // Incluye inspectores activos creados
      expect(idsDevueltos.has(inspectorActivoMontadoId)).toBe(true);
      expect(idsDevueltos.has(inspectorActivoCorteId)).toBe(true);

      // Excluye inspector inactivo, coordinadores y administradores
      expect(idsDevueltos.has(inspectorInactivoId)).toBe(false);
      expect(idsDevueltos.has(coordRestringidoMontadoId)).toBe(false);
      expect(idsDevueltos.has(adminGeneralId)).toBe(false);

      // Verificar en BD que todos los devueltos son realmente INSPECTOR + ACTIVO
      const enBd = await prisma.usuario.findMany({
        where: { id: { in: Array.from(idsDevueltos) } },
        include: { rol: true },
      });
      for (const u of enBd) {
        expect(u.estado).toBe("ACTIVO");
        expect(u.rol.codigo).toBe("INSPECTOR");
      }
    });

    it("4.2. Las inspecciones históricas de inspectores inactivos NO se ocultan ni alteran en las consultas históricas", async () => {
      const r = await api("GET", `/inspecciones?periodo=dia&dia=2025-06-15&limit=200`, "admin");
      expect(r.status).toBe(200);
      const filaInactivo = r.json.data.items.find((i: any) => i.inspeccionId === inspInactivoHistId);
      expect(filaInactivo).toBeDefined();
      expect(filaInactivo.inspectorId).toBe(inspectorInactivoId);
    });
  });

  // =========================================================================
  // 5. PERMISOS DEPARTAMENTALES
  // =========================================================================
  describe("5. Permisos departamentales en inspectores, periodos e historial", () => {
    it("5.1. GET /inspecciones/inspectores filtra por departamentoId y respeta el alcance departamental del coordinador", async () => {
      // Admin general filtrando por CORTE ve al inspector de CORTE y no al de MONTADO
      const rCorte = await api("GET", `/inspecciones/inspectores?departamentoId=${deptoCorteId}`, "admin");
      expect(rCorte.status).toBe(200);
      const idsCorte = new Set(rCorte.json.data.map((u: any) => u.id));
      expect(idsCorte.has(inspectorActivoCorteId)).toBe(true);
      expect(idsCorte.has(inspectorActivoMontadoId)).toBe(false);

      // Coordinador restringido a MONTADO solo ve inspectores de MONTADO por defecto
      const rCoord = await api("GET", "/inspecciones/inspectores", "coordMontado");
      expect(rCoord.status).toBe(200);
      const idsCoord = new Set(rCoord.json.data.map((u: any) => u.id));
      expect(idsCoord.has(inspectorActivoMontadoId)).toBe(true);
      expect(idsCoord.has(inspectorActivoCorteId)).toBe(false);

      // Si el coordinador restringido a MONTADO intenta pedir inspectores de CORTE -> 403 Forbidden
      const rCoordProhibido = await api(
        "GET",
        `/inspecciones/inspectores?departamentoId=${deptoCorteId}`,
        "coordMontado"
      );
      expect(rCoordProhibido.status).toBe(403);
    });

    it("5.2. Coordinador con alcance departamental solo consulta historial y periodos de sus departamentos autorizados", async () => {
      const rHist = await api("GET", "/inspecciones?periodo=dia&dia=2025-06-15&limit=200", "coordMontado");
      expect(rHist.status).toBe(200);
      const idsHist = new Set(rHist.json.data.items.map((i: any) => i.inspeccionId));
      // Ve las de MONTADO pero no la de CORTE
      expect(idsHist.has(inspNocheLocalId)).toBe(true);
      expect(idsHist.has(inspInactivoHistId)).toBe(false);

      // Si intenta forzar departamentoId de CORTE en historial o en periodos-disponibles -> 403 Forbidden
      const rForzadoHist = await api(
        "GET",
        `/inspecciones?periodo=todos&departamentoId=${deptoCorteId}`,
        "coordMontado"
      );
      expect(rForzadoHist.status).toBe(403);

      const rForzadoPeriodos = await api(
        "GET",
        `/inspecciones/periodos-disponibles?departamentoId=${deptoCorteId}`,
        "coordMontado"
      );
      expect(rForzadoPeriodos.status).toBe(403);
    });
  });

  // =========================================================================
  // 6. PERIODOS VACÍOS Y FUTUROS + 7. RANGOS PERSONALIZADOS SIN LÍMITE 366 DÍAS
  // =========================================================================
  describe("6 y 7. Validación de periodos vacíos, fechas futuras y rangos personalizados", () => {
    it("6.1. Rechaza con 400 fechas futuras, semanas futuras, meses futuros, años futuros y fechas de calendario inexistentes", async () => {
      const partesHoy = getPartesFechaMexico();
      const anioFuturo = partesHoy.anio + 1;

      const casosInvalidos = [
        `periodo=dia&dia=${anioFuturo}-01-01`,
        `periodo=anio&anio=${anioFuturo}`,
        `periodo=semana&anioIso=${anioFuturo}&semana=1`,
        `periodo=semana&anioIso=2025&semana=53`, // 2025 solo tiene 52 semanas ISO
        `periodo=rango&fechaDesde=2025-06-20&fechaHasta=2025-06-10`, // Rango invertido
        `periodo=rango&fechaDesde=2026-02-30&fechaHasta=2026-03-01`, // Fecha inexistente
        `periodo=dia&dia=2025-02-29`, // 2025 no es bisiesto
      ];

      for (const qs of casosInvalidos) {
        const r = await api("GET", `/inspecciones?${qs}`, "admin");
        expect(r.status).toBe(400);
      }
      expect(esFechaIsoValida("2025-02-29")).toBe(false);
      expect(esFechaIsoValida("2024-02-29")).toBe(true);
    });

    it("7.1. Permite rangos personalizados amplios (> 366 días, ej. multianual 2024 a hoy) sin límite arbitrario", async () => {
      const hoy = getHoyMexicoStr();
      const r = await api(
        "GET",
        `/inspecciones?periodo=rango&fechaDesde=2024-01-01&fechaHasta=${hoy}&inspectorId=${inspectorActivoMontadoId}&limit=50`,
        "admin"
      );
      expect(r.status).toBe(200);
      const ids = new Set(r.json.data.items.map((i: any) => i.inspeccionId));
      // Incluye tanto la de dic 2024 como las de jun 2025 (> 366 días de ventana consultada)
      expect(ids.has(inspCruceIso2024Id)).toBe(true);
      expect(ids.has(inspNocheLocalId)).toBe(true);
      expect(ids.has(inspFinDiaMsId)).toBe(true);
      expect(r.json.data.totalDefectos).toBe(4);
      expect(r.json.data.totalInspecciones).toBe(3);
    });
  });

  // =========================================================================
  // 8. REGISTROS ELIMINADOS LÓGICAMENTE Y 9. EXPORTACIÓN COMPLETA SIN TRUNCAMIENTO
  // =========================================================================
  describe("8 y 9. Registros eliminados lógicamente y endpoint de exportación completa", () => {
    it("8.1. Filtra correctamente registros eliminados lógicamente según soloEliminados", async () => {
      const rNormal = await api(
        "GET",
        `/inspecciones?periodo=dia&dia=2024-03-10&inspectorId=${inspectorActivoMontadoId}`,
        "admin"
      );
      expect(rNormal.status).toBe(200);
      expect(rNormal.json.data.totalDefectos).toBe(0);

      const rElim = await api(
        "GET",
        `/inspecciones?periodo=dia&dia=2024-03-10&inspectorId=${inspectorActivoMontadoId}&soloEliminados=true`,
        "superadmin"
      );
      expect(rElim.status).toBe(200);
      expect(rElim.json.data.totalDefectos).toBe(1);
      expect(rElim.json.data.totalInspecciones).toBe(1);
      expect(rElim.json.data.items[0].id).toBe(detalleEliminadoId);
      expect(rElim.json.data.items[0].inspeccionId).toBe(inspEliminadaId);
    });

    it("9.1. GET /inspecciones/exportar devuelve todos los registros sin truncamiento y coincide con totalDefectos y totalInspecciones", async () => {
      const hoy = getHoyMexicoStr();
      const qs = `periodo=rango&fechaDesde=2024-01-01&fechaHasta=${hoy}&inspectorId=${inspectorActivoMontadoId}`;

      const [rPaginado, rExportar] = await Promise.all([
        api("GET", `/inspecciones?${qs}&page=1&limit=1`, "admin"),
        api("GET", `/inspecciones/exportar?${qs}`, "admin"),
      ]);

      expect(rPaginado.status).toBe(200);
      expect(rExportar.status).toBe(200);

      // Aunque la tabla pida limit=1, la exportación devuelve los 4 defectos completos de las 3 inspecciones
      expect(rPaginado.json.data.items.length).toBe(1);
      expect(rPaginado.json.data.totalDefectos).toBe(4);
      expect(rPaginado.json.data.totalInspecciones).toBe(3);

      expect(rExportar.json.data.items.length).toBe(4);
      expect(rExportar.json.data.totalDefectos).toBe(4);
      expect(rExportar.json.data.totalInspecciones).toBe(3);
      expect(rExportar.json.data.total).toBe(4);
    });
  });
});

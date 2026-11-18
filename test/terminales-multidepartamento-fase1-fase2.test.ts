import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { securityService } from "../src/modules/auth/services/security.service";
import { terminalsService } from "../src/modules/auth/services/terminals.service";
import {
  clasificarDefectoEnTerminal,
  construirNomenclaturaDefecto,
  resolverLugarDeteccionTerminal,
} from "../src/modules/inspecciones/utils/nomenclatura-defectos";
import { offlineAuthService } from "../src/modules/auth/services/offline-auth.service";
import { construirBloquesCsvExportacion } from "../../frontend/src/features/registro/utils/exportar-reporte";
import type { Express } from "express";

describe("FASE 1 y FASE 2: Terminales Multidepartamento, Nombres Personalizados, Nomenclatura y Snapshots", () => {
  let app: Express;
  let server: any;
  let baseUrl: string;

  let superAdminToken = "";
  let inspectorToken = "";
  let superAdminId = 0;
  let inspectorId = 0;

  let deptoCorte: { id: number; codigo: string; nombre: string };
  let deptoPreliminares: { id: number; codigo: string; nombre: string };
  let deptoBordado: { id: number; codigo: string; nombre: string };
  let deptoMontado: { id: number; codigo: string; nombre: string };
  let deptoAcabado: { id: number; codigo: string; nombre: string };

  let defectoCorte: { id: number; clave: number; defecto: string; departamentoId: number };
  let defectoPreliminares: { id: number; clave: number; defecto: string; departamentoId: number };
  let defectoBordado: { id: number; clave: number; defecto: string; departamentoId: number };
  let defectoMontado: { id: number; clave: number; defecto: string; departamentoId: number };

  let loteActivo: { id: number; lote: string; cantidad: number };

  const terminalesCreadasIds: number[] = [];
  const inspeccionesCreadasIds: number[] = [];
  const usuariosCreadosIds: number[] = [];
  const reglasVisibilidadBackup: Array<{
    origenId: number;
    destinoId: number;
    existia: boolean;
    permitidoAnterior?: boolean;
  }> = [];

  const api = async (
    method: string,
    path: string,
    bearerToken: string | null,
    body?: unknown,
    terminalCredHeader?: string
  ) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearerToken) {
      headers.Authorization = `Bearer ${bearerToken}`;
    }
    if (terminalCredHeader) {
      headers["x-terminal-credential"] = terminalCredHeader;
    }
    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    return { status: res.status, json };
  };

  const asegurarVisibilidadEnMatriz = async (origenId: number, destinoId: number, permitido: boolean) => {
    const previa = await prisma.departamentoVisibilidadDefecto.findUnique({
      where: {
        unique_depto_origen_destino: {
          departamentoOrigenId: origenId,
          departamentoDestinoId: destinoId,
        },
      },
    });
    reglasVisibilidadBackup.push({
      origenId,
      destinoId,
      existia: Boolean(previa),
      permitidoAnterior: previa?.permitido,
    });
    await prisma.departamentoVisibilidadDefecto.upsert({
      where: {
        unique_depto_origen_destino: {
          departamentoOrigenId: origenId,
          departamentoDestinoId: destinoId,
        },
      },
      create: {
        departamentoOrigenId: origenId,
        departamentoDestinoId: destinoId,
        permitido,
      },
      update: {
        permitido,
      },
    });
  };

  beforeAll(async () => {
    app = createApp();
    server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    // 1. Obtener departamentos reales de la base de datos
    const deptos = await prisma.departamento.findMany({
      where: { estado: "ACTIVO" },
    });
    const findDepto = (match: (d: any) => boolean, label: string) => {
      const found = deptos.find(match);
      if (!found) throw new Error(`No se encontró departamento ${label}`);
      return { id: found.id, codigo: found.codigo, nombre: found.nombre };
    };

    deptoCorte = findDepto((d) => d.codigo.toUpperCase().includes("CORTE"), "CORTE");
    deptoPreliminares = findDepto((d) => d.codigo.toUpperCase().includes("PRELIM"), "PRELIMINARES");
    deptoBordado = findDepto((d) => d.codigo.toUpperCase().includes("BORD"), "BORDADO Y LÁSER");
    deptoMontado = findDepto((d) => d.codigo.toUpperCase().includes("MONT"), "MONTADO");
    deptoAcabado = findDepto((d) => d.codigo.toUpperCase().includes("ACAB"), "ACABADO");

    // 2. Obtener un defecto activo de cada departamento propietario
    const obtenerDefectoDepto = async (deptoId: number, nombreDepto: string) => {
      const def = await prisma.defecto.findFirst({
        where: {
          departamentoId: deptoId,
          activo: true,
          eliminadoEn: null,
          etapas: { none: { permitido: false } },
        },
        select: { id: true, clave: true, defecto: true, departamentoId: true },
      });
      if (!def) throw new Error(`No hay defecto activo para ${nombreDepto}`);
      return def;
    };

    defectoCorte = await obtenerDefectoDepto(deptoCorte.id, "CORTE");
    defectoPreliminares = await obtenerDefectoDepto(deptoPreliminares.id, "PRELIMINARES");
    defectoBordado = await obtenerDefectoDepto(deptoBordado.id, "BORDADO Y LÁSER");
    defectoMontado = await obtenerDefectoDepto(deptoMontado.id, "MONTADO");

    // Asegurar matriz de visibilidad para pruebas de defectos externos en estaciones receptoras
    await asegurarVisibilidadEnMatriz(deptoMontado.id, deptoAcabado.id, true);
    await asegurarVisibilidadEnMatriz(deptoCorte.id, deptoPreliminares.id, true);
    await asegurarVisibilidadEnMatriz(deptoBordado.id, deptoMontado.id, true);
    await asegurarVisibilidadEnMatriz(deptoPreliminares.id, deptoPreliminares.id, true);
    await asegurarVisibilidadEnMatriz(deptoBordado.id, deptoBordado.id, true);

    // 3. Lote activo
    const lote = await prisma.produccionLote.findFirst({
      where: { estado: "ACTIVO", eliminadoEn: null, cantidad: { gte: 10 } },
    });
    if (!lote) throw new Error("No se encontró lote activo para pruebas");
    loteActivo = { id: lote.id, lote: lote.lote, cantidad: Number(lote.cantidad) };

    // 4. Crear SuperAdmin e Inspector de prueba con sesión activa
    const crearUsuarioConToken = async (username: string, rolCodigo: string) => {
      const rol = await prisma.rol.findUniqueOrThrow({ where: { codigo: rolCodigo } });
      const u = await prisma.usuario.create({
        data: {
          usuario: username,
          nombre: `Test ${username}`,
          passwordHash: securityService.hashPassword("TestPass123!"),
          rolId: rol.id,
          estado: "ACTIVO",
        },
      });
      usuariosCreadosIds.push(u.id);
      const sesion = await prisma.sesion.create({
        data: {
          usuarioId: u.id,
          refreshTokenHash: `rt_${username}_${Date.now()}_${Math.random()}`,
          estado: "ACTIVO",
          fechaExpiracion: new Date(Date.now() + 86400000),
        },
      });
      const token = securityService.generateAccessToken({
        usuarioId: u.id,
        usuario: u.usuario,
        nombre: u.nombre,
        rolId: rol.id,
        rolCodigo: rol.codigo,
        sesionId: sesion.id,
      });
      return { id: u.id, token };
    };

    const sa = await crearUsuarioConToken(`sa_multidepto_${Date.now()}`, "SUPER_ADMIN");
    superAdminId = sa.id;
    superAdminToken = sa.token;

    const insp = await crearUsuarioConToken(`insp_multidepto_${Date.now()}`, "INSPECTOR");
    inspectorId = insp.id;
    inspectorToken = insp.token;
  });

  afterAll(async () => {
    for (const r of reglasVisibilidadBackup.reverse()) {
      if (r.existia && typeof r.permitidoAnterior === "boolean") {
        await prisma.departamentoVisibilidadDefecto
          .update({
            where: {
              unique_depto_origen_destino: {
                departamentoOrigenId: r.origenId,
                departamentoDestinoId: r.destinoId,
              },
            },
            data: { permitido: r.permitidoAnterior },
          })
          .catch(() => {});
      }
    }

    if (inspeccionesCreadasIds.length > 0) {
      await prisma.inspeccionDetalle
        .deleteMany({ where: { inspeccionId: { in: inspeccionesCreadasIds } } })
        .catch(() => {});
      await prisma.inspeccionCabecera
        .deleteMany({ where: { id: { in: inspeccionesCreadasIds } } })
        .catch(() => {});
    }

    if (terminalesCreadasIds.length > 0) {
      await prisma.registroAuditoria
        .deleteMany({ where: { terminalId: { in: terminalesCreadasIds } } })
        .catch(() => {});
      await prisma.terminal
        .deleteMany({ where: { id: { in: terminalesCreadasIds } } })
        .catch(() => {});
    }

    if (usuariosCreadosIds.length > 0) {
      await prisma.registroAuditoria
        .deleteMany({ where: { usuarioId: { in: usuariosCreadosIds } } })
        .catch(() => {});
      await prisma.sesion
        .deleteMany({ where: { usuarioId: { in: usuariosCreadosIds } } })
        .catch(() => {});
      await prisma.usuario
        .deleteMany({ where: { id: { in: usuariosCreadosIds } } })
        .catch(() => {});
    }

    if (server) server.close();
  });

  it("1. Verifica matemáticamente los 3 ejemplos obligatorios de nomenclatura y el caso de defecto propio en terminal compartida", () => {
    // Ejemplo obligatorio 1: Terminal ACABADO (1 depto: ACABADO), defecto propietario MONTADO
    const res1 = clasificarDefectoEnTerminal({
      terminalNombre: "PC-ACABADO-01",
      departamentosActivos: [{ departamentoId: deptoAcabado.id, nombre: "ACABADO", esPrincipal: true }],
      defectoDepartamentoId: deptoMontado.id,
      defectoDepartamentoNombre: "MONTADO",
    });
    expect(res1.lugarDeteccionTexto).toBe("ACABADO");
    expect(res1.esDeptoExterno).toBe(true);
    expect(res1.nomenclaturaTexto).toBe("DEFECTO DE MONTADO ENCONTRADO EN ACABADO");

    // Ejemplo obligatorio 2: Terminal SIGMA (asociada a BORDADO Y LÁSER y PRELIMINARES), defecto propietario CORTE
    const res2 = clasificarDefectoEnTerminal({
      terminalNombre: "SIGMA",
      departamentosActivos: [
        { departamentoId: deptoPreliminares.id, nombre: "PRELIMINARES", esPrincipal: true },
        { departamentoId: deptoBordado.id, nombre: "BORDADO Y LÁSER", esPrincipal: false },
      ],
      defectoDepartamentoId: deptoCorte.id,
      defectoDepartamentoNombre: "CORTE",
    });
    expect(res2.lugarDeteccionTexto).toBe("SIGMA");
    expect(res2.esDeptoExterno).toBe(true);
    expect(res2.nomenclaturaTexto).toBe("DEFECTO DE CORTE ENCONTRADO EN SIGMA");

    // Ejemplo obligatorio 3: Terminal MONTADO (1 depto: MONTADO), defecto propietario BORDADO Y LÁSER
    const res3 = clasificarDefectoEnTerminal({
      terminalNombre: "PC-MONTADO-01",
      departamentosActivos: [{ departamentoId: deptoMontado.id, nombre: "MONTADO", esPrincipal: true }],
      defectoDepartamentoId: deptoBordado.id,
      defectoDepartamentoNombre: "BORDADO Y LÁSER",
    });
    expect(res3.lugarDeteccionTexto).toBe("MONTADO");
    expect(res3.esDeptoExterno).toBe(true);
    expect(res3.nomenclaturaTexto).toBe("DEFECTO DE BORDADO Y LÁSER ENCONTRADO EN MONTADO");

    // Caso 4: Terminal SIGMA (BORDADO Y LÁSER + PRELIMINARES), defecto propio de PRELIMINARES
    const res4 = clasificarDefectoEnTerminal({
      terminalNombre: "SIGMA",
      departamentosActivos: [
        { departamentoId: deptoPreliminares.id, nombre: "PRELIMINARES", esPrincipal: true },
        { departamentoId: deptoBordado.id, nombre: "BORDADO Y LÁSER", esPrincipal: false },
      ],
      defectoDepartamentoId: deptoPreliminares.id,
      defectoDepartamentoNombre: "PRELIMINARES",
    });
    expect(res4.lugarDeteccionTexto).toBe("PRELIMINARES");
    expect(res4.esDeptoExterno).toBe(false);
    expect(res4.nomenclaturaTexto).toBe("DEFECTO DE PRELIMINARES ENCONTRADO EN PRELIMINARES");

    // Caso 5: Terminal SIGMA (BORDADO Y LÁSER + PRELIMINARES), defecto propio de BORDADO Y LÁSER
    const res5 = clasificarDefectoEnTerminal({
      terminalNombre: "SIGMA",
      departamentosActivos: [
        { departamentoId: deptoPreliminares.id, nombre: "PRELIMINARES", esPrincipal: true },
        { departamentoId: deptoBordado.id, nombre: "BORDADO Y LÁSER", esPrincipal: false },
      ],
      defectoDepartamentoId: deptoBordado.id,
      defectoDepartamentoNombre: "BORDADO Y LÁSER",
    });
    expect(res5.lugarDeteccionTexto).toBe("BORDADO Y LÁSER");
    expect(res5.esDeptoExterno).toBe(false);
    expect(res5.nomenclaturaTexto).toBe("DEFECTO DE BORDADO Y LÁSER ENCONTRADO EN BORDADO Y LÁSER");
  });

  it("2. Garantiza en MySQL y en servicio que una terminal activa tenga exactamente 1 departamento principal sincronizado", async () => {
    const sufijo = Date.now();
    const creada = await terminalsService.createTerminal({
      nombre: `TERM-INV-${sufijo}`,
      departamentoId: deptoPreliminares.id,
      departamentosIds: [deptoPreliminares.id, deptoBordado.id],
      usuarioAuditId: superAdminId,
    });
    terminalesCreadasIds.push(creada.terminal.id);

    expect(creada.terminal.departamentoId).toBe(deptoPreliminares.id);
    expect(creada.terminal.departamentosIds).toEqual(
      expect.arrayContaining([deptoPreliminares.id, deptoBordado.id])
    );
    expect(creada.terminal.lugarDeteccion).toBe(`TERM-INV-${sufijo}`);

    // Intentar violar la restricción en MySQL insertando un segundo principal activo para la misma terminal
    let errorMySqlDuplicado = false;
    try {
      await prisma.$executeRaw`
        UPDATE terminales_departamentos
        SET es_principal = 1
        WHERE terminal_id = ${creada.terminal.id} AND departamento_id = ${deptoBordado.id}
      `;
    } catch {
      errorMySqlDuplicado = true;
    }
    expect(errorMySqlDuplicado).toBe(true);

    // Intentar violar el CHECK constraint marcando es_principal = 1 con activo = 0
    let errorCheckConstraint = false;
    try {
      await prisma.$executeRaw`
        UPDATE terminales_departamentos
        SET activo = 0
        WHERE terminal_id = ${creada.terminal.id} AND es_principal = 1
      `;
    } catch {
      errorCheckConstraint = true;
    }
    expect(errorCheckConstraint).toBe(true);

    // Intentar por API dejar la terminal sin departamentos o con principal fuera de la lista
    const resInvalida = await api(
      "PUT",
      `/terminales/${creada.terminal.id}/departamentos`,
      superAdminToken,
      {
        departamentosIds: [deptoBordado.id],
        departamentoPrincipalId: deptoPreliminares.id, // No está en departamentosIds
      }
    );
    expect(resInvalida.status).toBe(400);
  });

  it("3. Soporta captura real en terminal compartida SIGMA (PRELIMINARES + BORDADO Y LÁSER), preserva snapshots y resiste renombrado posterior a ALFA", async () => {
    const sufijo = Date.now();
    const nombreSigma = `SIGMA-${sufijo}`;
    const nombreAlfa = `ALFA-${sufijo}`;

    // 1. Crear terminal SIGMA con PRELIMINARES (principal) y BORDADO Y LÁSER
    const altaRes = await api("POST", "/terminales", superAdminToken, {
      nombre: nombreSigma,
      departamentoId: deptoPreliminares.id,
      departamentosIds: [deptoPreliminares.id, deptoBordado.id],
    });
    expect(altaRes.status).toBe(201);
    const terminalSigmaId = altaRes.json.data.terminal.id as number;
    const credencialSigma = altaRes.json.data.credencial as string;
    terminalesCreadasIds.push(terminalSigmaId);

    // Verificar /terminales/estado con la credencial física
    const estadoRes = await api("GET", "/terminales/estado", null, undefined, credencialSigma);
    expect(estadoRes.status).toBe(200);
    expect(estadoRes.json.data.vinculada).toBe(true);
    expect(estadoRes.json.data.terminal.lugarDeteccion).toBe(nombreSigma);
    expect(estadoRes.json.data.terminal.departamentosIds).toEqual(
      expect.arrayContaining([deptoPreliminares.id, deptoBordado.id])
    );

    // 2. Capturar inspección en SIGMA con defectos de PRELIMINARES (propio), BORDADO Y LÁSER (propio) y CORTE (externo)
    const capSigmaRes = await api(
      "POST",
      "/inspecciones",
      inspectorToken,
      {
        lote: loteActivo.lote,
        detalles: [
          { defectoId: defectoPreliminares.id, paresDefectuosos: 2 },
          { defectoId: defectoBordado.id, paresDefectuosos: 3 },
          { defectoId: defectoCorte.id, paresDefectuosos: 1 },
        ],
      },
      credencialSigma
    );
    expect(capSigmaRes.status).toBe(201);
    const inspSigmaId = capSigmaRes.json.data.id as number;
    inspeccionesCreadasIds.push(inspSigmaId);

    // 3. Comprobar en MySQL que la cabecera conserva siempre el departamento principal (PRELIMINARES) y los snapshots
    const cabeceraDb = await prisma.inspeccionCabecera.findUniqueOrThrow({
      where: { id: inspSigmaId },
      include: { detalles: true },
    });
    expect(cabeceraDb.departamentoAuditoriaId).toBe(deptoPreliminares.id);
    expect(cabeceraDb.terminalTexto).toBe(nombreSigma);
    expect(cabeceraDb.lugarDeteccionTexto).toBe(nombreSigma);
    expect(Array.isArray(cabeceraDb.departamentosTerminalSnapshot)).toBe(true);
    expect((cabeceraDb.departamentosTerminalSnapshot as any[]).length).toBe(2);

    const detPrelim = cabeceraDb.detalles.find((d) => d.defectoId === defectoPreliminares.id)!;
    const detBordado = cabeceraDb.detalles.find((d) => d.defectoId === defectoBordado.id)!;
    const detCorte = cabeceraDb.detalles.find((d) => d.defectoId === defectoCorte.id)!;

    expect(detPrelim.defDeptoId).toBe(deptoPreliminares.id);
    expect(detPrelim.esDeptoExterno).toBe(false);
    expect(detPrelim.lugarDeteccionTexto).toBe(deptoPreliminares.nombre);
    expect(detPrelim.nomenclaturaTexto).toBe(
      construirNomenclaturaDefecto(deptoPreliminares.nombre, deptoPreliminares.nombre)
    );

    expect(detBordado.defDeptoId).toBe(deptoBordado.id);
    expect(detBordado.esDeptoExterno).toBe(false);
    expect(detBordado.lugarDeteccionTexto).toBe(deptoBordado.nombre);
    expect(detBordado.nomenclaturaTexto).toBe(
      construirNomenclaturaDefecto(deptoBordado.nombre, deptoBordado.nombre)
    );

    expect(detCorte.defDeptoId).toBe(deptoCorte.id);
    expect(detCorte.esDeptoExterno).toBe(true);
    expect(detCorte.lugarDeteccionTexto).toBe(nombreSigma);
    expect(detCorte.nomenclaturaTexto).toBe(
      `DEFECTO DE ${deptoCorte.nombre.toUpperCase()} ENCONTRADO EN ${nombreSigma.toUpperCase()}`
    );

    // 4. Renombrar la terminal de SIGMA a ALFA y verificar que el historial previo NO cambie
    const renameRes = await api(
      "PATCH",
      `/terminales/${terminalSigmaId}/nombre`,
      superAdminToken,
      {
        nombre: nombreAlfa,
        motivo: "Reubicación de estación compartida a zona ALFA",
      }
    );
    expect(renameRes.status).toBe(200);
    expect(renameRes.json.data.nombre).toBe(nombreAlfa);
    expect(renameRes.json.data.lugarDeteccion).toBe(nombreAlfa);

    // Capturar una nueva inspección ahora que se llama ALFA
    const capAlfaRes = await api(
      "POST",
      "/inspecciones",
      inspectorToken,
      {
        lote: loteActivo.lote,
        detalles: [{ defectoId: defectoCorte.id, paresDefectuosos: 1 }],
      },
      credencialSigma
    );
    expect(capAlfaRes.status).toBe(201);
    const inspAlfaId = capAlfaRes.json.data.id as number;
    inspeccionesCreadasIds.push(inspAlfaId);

    // Consultar historial y verificar que la primera conserva SIGMA y la segunda tiene ALFA
    const histRes = await api(
      "GET",
      `/inspecciones?periodo=hoy&terminalId=${terminalSigmaId}&limit=50`,
      superAdminToken
    );
    expect(histRes.status).toBe(200);
    const filas = histRes.json.data.items as any[];

    const filaCorteEnSigma = filas.find(
      (f) => f.inspeccionId === inspSigmaId && f.defectoId === defectoCorte.id
    );
    const filaCorteEnAlfa = filas.find(
      (f) => f.inspeccionId === inspAlfaId && f.defectoId === defectoCorte.id
    );

    expect(filaCorteEnSigma).toBeDefined();
    expect(filaCorteEnSigma.terminal).toBe(nombreSigma);
    expect(filaCorteEnSigma.lugarDeteccion).toBe(nombreSigma);
    expect(filaCorteEnSigma.nomenclatura).toBe(
      `DEFECTO DE ${deptoCorte.nombre.toUpperCase()} ENCONTRADO EN ${nombreSigma.toUpperCase()}`
    );

    expect(filaCorteEnAlfa).toBeDefined();
    expect(filaCorteEnAlfa.terminal).toBe(nombreAlfa);
    expect(filaCorteEnAlfa.lugarDeteccion).toBe(nombreAlfa);
    expect(filaCorteEnAlfa.nomenclatura).toBe(
      `DEFECTO DE ${deptoCorte.nombre.toUpperCase()} ENCONTRADO EN ${nombreAlfa.toUpperCase()}`
    );

    // 5. Desasociar BORDADO Y LÁSER dejando a la terminal con 1 solo departamento (PRELIMINARES)
    const updateDeptosRes = await api(
      "PUT",
      `/terminales/${terminalSigmaId}/departamentos`,
      superAdminToken,
      {
        departamentosIds: [deptoPreliminares.id],
        departamentoPrincipalId: deptoPreliminares.id,
        motivo: "Pasa a operar exclusivamente con PRELIMINARES",
      }
    );
    expect(updateDeptosRes.status).toBe(200);
    expect(updateDeptosRes.json.data.lugarDeteccion).toBe(deptoPreliminares.nombre);

    // Capturar con 1 solo departamento activo: ahora el lugar de detección debe ser el nombre del departamento (PRELIMINARES)
    const capUnDeptoRes = await api(
      "POST",
      "/inspecciones",
      inspectorToken,
      {
        lote: loteActivo.lote,
        detalles: [{ defectoId: defectoCorte.id, paresDefectuosos: 1 }],
      },
      credencialSigma
    );
    expect(capUnDeptoRes.status).toBe(201);
    const inspUnDeptoId = capUnDeptoRes.json.data.id as number;
    inspeccionesCreadasIds.push(inspUnDeptoId);

    const detUnDeptoDb = await prisma.inspeccionDetalle.findFirstOrThrow({
      where: { inspeccionId: inspUnDeptoId },
    });
    expect(detUnDeptoDb.lugarDeteccionTexto).toBe(deptoPreliminares.nombre);
    expect(detUnDeptoDb.nomenclaturaTexto).toBe(
      `DEFECTO DE ${deptoCorte.nombre.toUpperCase()} ENCONTRADO EN ${deptoPreliminares.nombre.toUpperCase()}`
    );
  });

  it("4. FASE 3 (Offline): Sincroniza capturas offline multidepartamentales y preserva en revisión (PENDIENTE) capturas realizadas antes de una desasociación o renombrado concurrente", async () => {
    const sufijo = Date.now();
    const nombreOriginal = `SIGMA-OFF-${sufijo}`;
    const nombreRenombrado = `OMEGA-OFF-${sufijo}`;

    // 1. Crear terminal compartida con PRELIMINARES (principal) y BORDADO Y LÁSER
    const creada = await terminalsService.createTerminal({
      nombre: nombreOriginal,
      departamentoId: deptoPreliminares.id,
      departamentosIds: [deptoPreliminares.id, deptoBordado.id],
      usuarioAuditId: superAdminId,
    });
    const termId = creada.terminal.id;
    const termCred = creada.credencial;
    terminalesCreadasIds.push(termId);

    // 2. Solicitar token offline desde la estación compartida
    const tokenRes = await api(
      "POST",
      "/auth/offline-token",
      inspectorToken,
      {},
      termCred
    );
    expect(tokenRes.status).toBe(200);
    const offlineToken = tokenRes.json.data.offlineToken as string;
    expect(offlineToken).toBeTruthy();

    // 3. Sincronizar una captura offline normal con defectos de BORDADO Y LÁSER
    const idLocalNormal = `off-normal-${sufijo}`;
    const syncNormal = await api(
      "POST",
      "/inspecciones/sync",
      null,
      {
        items: [
          {
            idLocalCliente: idLocalNormal,
            inspectorId,
            offlineToken,
            fechaCapturaDispositivo: new Date().toISOString(),
            payload: {
              lote: loteActivo.lote,
              detalles: [{ defectoId: defectoBordado.id, paresDefectuosos: 2 }],
            },
          },
        ],
      },
      termCred
    );
    expect(syncNormal.status).toBe(200);
    const resNormal = syncNormal.json.data.resultados[0];
    expect(resNormal.estado).toBe("SINCRONIZADA");
    expect(resNormal.requiereRevision).toBe(false);
    inspeccionesCreadasIds.push(resNormal.inspeccionId);

    // 4. Mientras la terminal está offline con otra captura pendiente de BORDADO Y LÁSER,
    // el SuperAdmin en el servidor desasocia BORDADO Y LÁSER y renombra la terminal a OMEGA-OFF
    await terminalsService.renameTerminal({
      terminalId: termId,
      nombre: nombreRenombrado,
      usuarioAuditId: superAdminId,
    });
    await terminalsService.updateTerminalDepartamentos({
      terminalId: termId,
      departamentosIds: [deptoPreliminares.id],
      departamentoPrincipalId: deptoPreliminares.id,
      usuarioAuditId: superAdminId,
    });

    // 5. La terminal reconecta y sincroniza la captura que fue realizada cuando aún era SIGMA-OFF y tenía BORDADO Y LÁSER
    const idLocalConcurrente = `off-concurrente-${sufijo}`;
    const syncConcurrente = await api(
      "POST",
      "/inspecciones/sync",
      null,
      {
        items: [
          {
            idLocalCliente: idLocalConcurrente,
            inspectorId,
            offlineToken,
            fechaCapturaDispositivo: new Date().toISOString(),
            payload: {
              lote: loteActivo.lote,
              detalles: [{ defectoId: defectoBordado.id, paresDefectuosos: 1 }],
            },
          },
        ],
      },
      termCred
    );
    expect(syncConcurrente.status).toBe(200);
    const resConc = syncConcurrente.json.data.resultados[0];
    // NO se rechaza con 403: se sincroniza en MySQL marcada con requiereRevision = true (estado PENDIENTE)
    expect(resConc.estado).toBe("SINCRONIZADA");
    expect(resConc.requiereRevision).toBe(true);
    inspeccionesCreadasIds.push(resConc.inspeccionId);

    const cabConcDb = await prisma.inspeccionCabecera.findUniqueOrThrow({
      where: { id: resConc.inspeccionId },
      include: { detalles: true },
    });
    expect(cabConcDb.estado).toBe("PENDIENTE");
    expect(cabConcDb.terminalTexto).toBe(nombreOriginal);
    expect(cabConcDb.lugarDeteccionTexto).toBe(nombreOriginal);
    expect(cabConcDb.detalles[0].nomenclaturaTexto).toBe(
      `DEFECTO DE ${deptoBordado.nombre.toUpperCase()} ENCONTRADO EN ${deptoBordado.nombre.toUpperCase()}`
    );

    // 6. Verificar que un token emitido para un departamento que NUNCA perteneció a esa terminal (ej. MONTADO) sí sea rechazado con 403
    const tokenAjeno = offlineAuthService.generateOfflineToken({
      usuarioId: inspectorId,
      usuario: `insp_multidepto`,
      nombre: "Inspector",
      terminalId: termId,
      terminalNombre: nombreRenombrado,
      departamentoId: deptoMontado.id,
    });
    const syncAjeno = await api(
      "POST",
      "/inspecciones/sync",
      null,
      {
        items: [
          {
            idLocalCliente: `off-ajeno-${sufijo}`,
            inspectorId,
            offlineToken: tokenAjeno.token,
            fechaCapturaDispositivo: new Date().toISOString(),
            payload: {
              lote: loteActivo.lote,
              detalles: [{ defectoId: defectoPreliminares.id, paresDefectuosos: 1 }],
            },
          },
        ],
      },
      termCred
    );
    expect(syncAjeno.status).toBe(200);
    expect(syncAjeno.json.data.resultados[0].estado).toBe("RECHAZADA");
    expect(syncAjeno.json.data.resultados[0].codigoHttp).toBe(403);
  });

  it("5. FASE 4 (Catálogo Multidepartamental y Exportación CSV de 16 Columnas): Carga defectos de ambos departamentos y exporta Lugar de Detección y Nomenclatura en posiciones 15 y 16", async () => {
    const sufijo = Date.now();
    const nombreEstacion = `SIGMA-EXP-${sufijo}`;

    const creada = await terminalsService.createTerminal({
      nombre: nombreEstacion,
      departamentoId: deptoPreliminares.id,
      departamentosIds: [deptoPreliminares.id, deptoBordado.id],
      usuarioAuditId: superAdminId,
    });
    terminalesCreadasIds.push(creada.terminal.id);

    // 1. Consultar catálogo de defectos desde la terminal compartida pasando etapasIds
    const catRes = await api(
      "GET",
      `/defectos?etapasIds=${deptoPreliminares.id},${deptoBordado.id}&activo=true&limit=500`,
      inspectorToken,
      undefined,
      creada.credencial
    );
    expect(catRes.status).toBe(200);
    const itemsCat = catRes.json.data.items as any[];
    expect(itemsCat.some((d) => d.id === defectoPreliminares.id)).toBe(true);
    expect(itemsCat.some((d) => d.id === defectoBordado.id)).toBe(true);

    // 2. Validar captura de defecto de BORDADO Y LÁSER en la estación cuyo principal es PRELIMINARES
    const valRes = await api(
      "GET",
      `/defectos/validar-captura?clave=${defectoBordado.clave}&etapaId=${deptoPreliminares.id}`,
      inspectorToken,
      undefined,
      creada.credencial
    );
    expect(valRes.status).toBe(200);
    expect(valRes.json.data.estado).toBe("VALIDO");

    // 3. Registrar captura y verificar exportación CSV de 16 columnas (posiciones 15 y 16)
    const capRes = await api(
      "POST",
      "/inspecciones",
      inspectorToken,
      {
        lote: loteActivo.lote,
        detalles: [{ defectoId: defectoCorte.id, paresDefectuosos: 4 }],
      },
      creada.credencial
    );
    expect(capRes.status).toBe(201);
    inspeccionesCreadasIds.push(capRes.json.data.id);

    const expRes = await api(
      "GET",
      `/inspecciones/exportar?periodo=hoy&terminalId=${creada.terminal.id}`,
      superAdminToken
    );
    expect(expRes.status).toBe(200);
    const filasExport = expRes.json.data.items as any[];
    expect(filasExport.length).toBeGreaterThanOrEqual(1);

    const chunks = construirBloquesCsvExportacion(filasExport);
    const csvCompleto = chunks.join("");
    const lineasCsv = csvCompleto.replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lineasCsv.length).toBeGreaterThanOrEqual(2);

    const headers = lineasCsv[0].split(",");
    expect(headers.length).toBe(16);
    expect(headers[14]).toBe('"Lugar de Detección"');
    expect(headers[15]).toBe('"Nomenclatura"');

    const primeraFilaDatos = lineasCsv[1];
    expect(primeraFilaDatos).toContain(`"${nombreEstacion}"`);
    expect(primeraFilaDatos).toContain(
      `"DEFECTO DE ${deptoCorte.nombre.toUpperCase()} ENCONTRADO EN ${nombreEstacion.toUpperCase()}"`
    );
  });
});

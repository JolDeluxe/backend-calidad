import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { securityService } from "../src/modules/auth/services/security.service";
import { terminalsService } from "../src/modules/auth/services/terminals.service";
import type { Express } from "express";

/**
 * Pruebas de Cumplimiento Normativo de Reglas de Acceso:
 * 1. El INSPECTOR no está asignado permanentemente a un departamento; su contexto lo define la terminal física.
 * 2. Los registros NO son privados por inspector: visibilidad por departamento de la terminal.
 * 3. Bloqueo 403 a inspectores ante manipulación de parámetros de otros departamentos.
 * 4. Acceso global irrestricto de consulta para ADMIN y COORD.
 * 5. Trazabilidad y preservación del usuario creador (inspectorId) para auditoría.
 */
describe("Reglas de Negocio: Terminales, Inspectores, Alcance Departamental y Roles Administrativos", () => {
  let app: Express;
  let server: any;
  let baseUrl: string;

  const tokens: Record<string, string> = {};
  const usuariosCreadosIds: number[] = [];
  const inspeccionesCreadasIds: number[] = [];
  const terminalesCreadasIds: number[] = [];

  let deptoCorteId: number;
  let deptoMontadoId: number;
  let deptoAviosId: number;

  let terminalCorteId: number;
  let terminalCorteCred: string;
  let terminalMontadoId: number;
  let terminalMontadoCred: string;

  let loteActivo: { id: number; lote: string; cantidad: number };
  let defectoCorte: { id: number; clave: number };
  let defectoMontado: { id: number; clave: number };

  let juanitoId: number;
  let sutanitoId: number;
  let inspSinDeptosId: number;
  let inspResidualAviosId: number;
  let coordUserId: number;
  let adminUserId: number;

  let inspJuanitoCorteId: number;
  let inspJuanitoMontadoId: number;

  const api = async (
    method: string,
    path: string,
    tokenUserKey: string | null,
    body?: unknown,
    terminalCredHeader?: string
  ) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (tokenUserKey && tokens[tokenUserKey]) {
      headers.Authorization = `Bearer ${tokens[tokenUserKey]}`;
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
    return { status: res.status, json, headers: res.headers };
  };

  const asegurarUsuario = async (
    usuario: string,
    rolCodigo: string,
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

    const login = await api("POST", "/auth/login", null, { usuario, password: "TestPass123!" });
    if (login.status !== 200) {
      throw new Error(`No se pudo autenticar usuario ${usuario}: ${JSON.stringify(login.json)}`);
    }
    return { id: u.id, token: login.json.data.accessToken as string };
  };

  beforeAll(async () => {
    app = createApp();
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    // 1. Departamentos base
    const corte = await prisma.departamento.findFirst({ where: { codigo: "CORTE", estado: "ACTIVO" } });
    const montado = await prisma.departamento.findFirst({ where: { codigo: "MONTADO", estado: "ACTIVO" } });
    const avios = await prisma.departamento.findFirst({ where: { codigo: "AVIOS", estado: "ACTIVO" } });

    if (!corte || !montado || !avios) {
      throw new Error("Se requieren departamentos CORTE, MONTADO y AVIOS en el seed de la base de datos.");
    }

    deptoCorteId = corte.id;
    deptoMontadoId = montado.id;
    deptoAviosId = avios.id;

    // 2. Terminales físicas
    const tCorte = await terminalsService.createTerminal({
      nombre: `PC-CORTE-TEST-${Date.now()}`,
      departamentoId: deptoCorteId,
    });
    terminalCorteId = tCorte.terminal.id;
    terminalCorteCred = tCorte.credencial;
    terminalesCreadasIds.push(terminalCorteId);

    const tMontado = await terminalsService.createTerminal({
      nombre: `PC-MONTADO-TEST-${Date.now()}`,
      departamentoId: deptoMontadoId,
    });
    terminalMontadoId = tMontado.terminal.id;
    terminalMontadoCred = tMontado.credencial;
    terminalesCreadasIds.push(terminalMontadoId);

    // 3. Usuarios de prueba
    // Juanito: Inspector sin departamento asignado
    const rJuanito = await asegurarUsuario("t_juanito_insp", "INSPECTOR", []);
    juanitoId = rJuanito.id;
    tokens.juanito = rJuanito.token;

    // Sutanito: Inspector sin departamento asignado
    const rSutanito = await asegurarUsuario("t_sutanito_insp", "INSPECTOR", []);
    sutanitoId = rSutanito.id;
    tokens.sutanito = rSutanito.token;

    // Inspector explícitamente sin usuarios_departamentos
    const rSinDeptos = await asegurarUsuario("t_insp_sin_deptos", "INSPECTOR", []);
    inspSinDeptosId = rSinDeptos.id;
    tokens.inspSinDeptos = rSinDeptos.token;

    // Inspector con fila residual en usuarios_departamentos (ej. AVIOS)
    const rResidual = await asegurarUsuario("t_insp_residual_avios", "INSPECTOR", [deptoAviosId]);
    inspResidualAviosId = rResidual.id;
    tokens.inspResidual = rResidual.token;

    // Coordinador y Administrador
    const rCoord = await asegurarUsuario("t_coord_global", "COORD", [deptoMontadoId]);
    coordUserId = rCoord.id;
    tokens.coord = rCoord.token;

    const rAdmin = await asegurarUsuario("t_admin_global", "ADMIN", [deptoAviosId]);
    adminUserId = rAdmin.id;
    tokens.admin = rAdmin.token;

    // 4. Lote de producción activo
    const lote = await prisma.produccionLote.findFirst({
      where: { estado: "ACTIVO", eliminadoEn: null, cantidad: { gte: 10 } },
      orderBy: { id: "desc" },
    });
    if (!lote) throw new Error("Se requiere al menos un lote activo con cantidad >= 10");
    loteActivo = { id: lote.id, lote: lote.lote, cantidad: Math.floor(Number(lote.cantidad)) };

    // 5. Defectos permitidos por etapa
    const defCorteEtapa = await prisma.defectoEtapa.findFirst({
      where: { departamentoId: deptoCorteId, permitido: true, defecto: { activo: true, eliminadoEn: null } },
      include: { defecto: true },
    });
    if (!defCorteEtapa) throw new Error("Se requiere al menos un defecto permitido para etapa CORTE");
    defectoCorte = { id: defCorteEtapa.defectoId, clave: defCorteEtapa.defecto.clave };

    const defMontadoEtapa = await prisma.defectoEtapa.findFirst({
      where: { departamentoId: deptoMontadoId, permitido: true, defecto: { activo: true, eliminadoEn: null } },
      include: { defecto: true },
    });
    if (!defMontadoEtapa) throw new Error("Se requiere al menos un defecto permitido para etapa MONTADO");
    defectoMontado = { id: defMontadoEtapa.defectoId, clave: defMontadoEtapa.defecto.clave };
  });

  afterAll(async () => {
    try {
      server?.close();
      if (inspeccionesCreadasIds.length > 0) {
        await prisma.inspeccionDetalle.deleteMany({
          where: { inspeccionId: { in: inspeccionesCreadasIds } },
        });
        await prisma.inspeccionCabecera.deleteMany({
          where: { id: { in: inspeccionesCreadasIds } },
        });
      }
      if (terminalesCreadasIds.length > 0) {
        await prisma.terminal.deleteMany({
          where: { id: { in: terminalesCreadasIds } },
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
    } catch {
      // Ignorar errores de cleanup
    }
  });

  // =========================================================================
  // ESCENARIO 1: Juanito captura en CORTE y Sutanito consulta en CORTE
  // =========================================================================
  it("Escenario 1: Juanito captura en CORTE y Sutanito consulta desde CORTE (visibilidad por departamento, registros no privados)", async () => {
    // Juanito captura una inspección en la terminal de CORTE
    const resCaptura = await api(
      "POST",
      "/inspecciones",
      "juanito",
      {
        lote: loteActivo.lote,
        detalles: [{ defectoId: defectoCorte.id, paresDefectuosos: 1, notas: "Capturado por Juanito en CORTE" }],
      },
      terminalCorteCred
    );

    expect(resCaptura.status).toBe(201);
    inspJuanitoCorteId = resCaptura.json.data.id;
    inspeccionesCreadasIds.push(inspJuanitoCorteId);

    // Sutanito inicia sesión y consulta el historial desde la terminal de CORTE
    const resConsultaSutanito = await api(
      "GET",
      "/inspecciones?periodo=hoy",
      "sutanito",
      undefined,
      terminalCorteCred
    );

    expect(resConsultaSutanito.status).toBe(200);
    const items = resConsultaSutanito.json.data.items as any[];
    const encontrada = items.find((i) => i.inspeccionId === inspJuanitoCorteId);

    expect(encontrada).toBeDefined();
    // Sutanito ve la captura de Juanito en CORTE
    expect(encontrada.departamentoAuditoriaCodigo).toBe("CORTE");

    // Sutanito también puede consultar el detalle completo de la inspección de Juanito
    const resDetalle = await api(
      "GET",
      `/inspecciones/${inspJuanitoCorteId}`,
      "sutanito",
      undefined,
      terminalCorteCred
    );
    expect(resDetalle.status).toBe(200);
    expect(resDetalle.json.data.id).toBe(inspJuanitoCorteId);
  });

  // =========================================================================
  // ESCENARIO 2: Juanito captura en MONTADO y Sutanito consulta en MONTADO
  // =========================================================================
  it("Escenario 2: Juanito captura en MONTADO y Sutanito consulta desde MONTADO (permite cualquier departamento según terminal)", async () => {
    // Juanito (el mismo inspector) ahora captura en la terminal de MONTADO
    const resCaptura = await api(
      "POST",
      "/inspecciones",
      "juanito",
      {
        lote: loteActivo.lote,
        detalles: [{ defectoId: defectoMontado.id, paresDefectuosos: 2, notas: "Capturado por Juanito en MONTADO" }],
      },
      terminalMontadoCred
    );

    expect(resCaptura.status).toBe(201);
    inspJuanitoMontadoId = resCaptura.json.data.id;
    inspeccionesCreadasIds.push(inspJuanitoMontadoId);

    // Sutanito consulta desde la terminal de MONTADO
    const resConsulta = await api(
      "GET",
      "/inspecciones?periodo=hoy",
      "sutanito",
      undefined,
      terminalMontadoCred
    );

    expect(resConsulta.status).toBe(200);
    const items = resConsulta.json.data.items as any[];
    const encontrada = items.find((i) => i.inspeccionId === inspJuanitoMontadoId);

    expect(encontrada).toBeDefined();
    expect(encontrada.departamentoAuditoriaCodigo).toBe("MONTADO");
  });

  // =========================================================================
  // ESCENARIO 3: Sutanito cambia de terminal física (CORTE -> MONTADO) dinámicamente
  // =========================================================================
  it("Escenario 3: Sutanito cambia de terminal de CORTE a MONTADO: el contexto conmuta automáticamente sin alterar el usuario", async () => {
    // En CORTE: Sutanito ve la inspección de CORTE pero NO la de MONTADO
    const resCorte = await api("GET", "/inspecciones?periodo=hoy", "sutanito", undefined, terminalCorteCred);
    expect(resCorte.status).toBe(200);
    const itemsCorte = resCorte.json.data.items as any[];
    const idsCorte = new Set(itemsCorte.map((i) => i.inspeccionId));
    expect(idsCorte.has(inspJuanitoCorteId)).toBe(true);
    expect(idsCorte.has(inspJuanitoMontadoId)).toBe(false);

    // En MONTADO: Sutanito ve la inspección de MONTADO pero NO la de CORTE
    const resMontado = await api("GET", "/inspecciones?periodo=hoy", "sutanito", undefined, terminalMontadoCred);
    expect(resMontado.status).toBe(200);
    const itemsMontado = resMontado.json.data.items as any[];
    const idsMontado = new Set(itemsMontado.map((i) => i.inspeccionId));
    expect(idsMontado.has(inspJuanitoMontadoId)).toBe(true);
    expect(idsMontado.has(inspJuanitoCorteId)).toBe(false);

    // Verificar en MySQL que Sutanito sigue sin requerir registros en usuarios_departamentos
    const deptoRows = await prisma.usuarioDepartamento.count({ where: { usuarioId: sutanitoId } });
    expect(deptoRows).toBe(0);
  });

  // =========================================================================
  // ESCENARIO 4: Inspector sin usuarios_departamentos captura y consulta
  // =========================================================================
  it("Escenario 4: Inspector sin ningún departamento asignado captura y consulta correctamente en cualquier terminal", async () => {
    // Verificar que inspSinDeptos no tiene asignaciones
    const countDeptos = await prisma.usuarioDepartamento.count({ where: { usuarioId: inspSinDeptosId } });
    expect(countDeptos).toBe(0);

    // Captura en CORTE
    const resCaptura = await api(
      "POST",
      "/inspecciones",
      "inspSinDeptos",
      {
        lote: loteActivo.lote,
        detalles: [{ defectoId: defectoCorte.id, paresDefectuosos: 1, notas: "Sin asignación permanente" }],
      },
      terminalCorteCred
    );
    expect(resCaptura.status).toBe(201);
    const nuevaId = resCaptura.json.data.id;
    inspeccionesCreadasIds.push(nuevaId);

    // Consulta en CORTE
    const resConsulta = await api("GET", "/inspecciones?periodo=hoy", "inspSinDeptos", undefined, terminalCorteCred);
    expect(resConsulta.status).toBe(200);
    const items = resConsulta.json.data.items as any[];
    expect(items.some((i) => i.inspeccionId === nuevaId)).toBe(true);
  });

  // =========================================================================
  // ESCENARIO 5: Inspector con usuarios_departamentos residual no se restringe
  // =========================================================================
  it("Escenario 5: Inspector con asignación residual (AVIOS) NO queda restringido al operar en terminal de CORTE", async () => {
    // inspResidual tiene asignación a AVIOS en DB
    const asignacion = await prisma.usuarioDepartamento.findFirst({
      where: { usuarioId: inspResidualAviosId, departamentoId: deptoAviosId },
    });
    expect(asignacion).toBeDefined();

    // Sin embargo, al iniciar sesión y operar en terminal de CORTE, su contexto es CORTE
    const resCaptura = await api(
      "POST",
      "/inspecciones",
      "inspResidual",
      {
        lote: loteActivo.lote,
        detalles: [{ defectoId: defectoCorte.id, paresDefectuosos: 1, notas: "Residual AVIOS operando en CORTE" }],
      },
      terminalCorteCred
    );
    expect(resCaptura.status).toBe(201);
    const idCorte = resCaptura.json.data.id;
    inspeccionesCreadasIds.push(idCorte);

    // Consulta en CORTE: recibe 200 OK y ve los registros de CORTE (no se bloquea ni se fuerza a AVIOS)
    const resConsulta = await api("GET", "/inspecciones?periodo=hoy", "inspResidual", undefined, terminalCorteCred);
    expect(resConsulta.status).toBe(200);
    const items = resConsulta.json.data.items as any[];
    expect(items.some((i) => i.inspeccionId === idCorte)).toBe(true);
  });

  // =========================================================================
  // ESCENARIO 6: Inspector en CORTE intenta consultar otro depto -> 403 Forbidden
  // =========================================================================
  it("Escenario 6: Inspector en terminal de CORTE intenta forzar departamentoId/departamentoAuditoriaId de MONTADO -> 403 Forbidden", async () => {
    // 1. Manipulación de departamentoId en GET /inspecciones
    const resForzado1 = await api(
      "GET",
      `/inspecciones?periodo=hoy&departamentoId=${deptoMontadoId}`,
      "sutanito",
      undefined,
      terminalCorteCred
    );
    expect(resForzado1.status).toBe(403);
    expect(resForzado1.json.error || resForzado1.json.message).toMatch(/otro departamento/i);

    // 2. Manipulación de departamentoAuditoriaId en GET /inspecciones
    const resForzado2 = await api(
      "GET",
      `/inspecciones?periodo=hoy&departamentoAuditoriaId=${deptoMontadoId}`,
      "sutanito",
      undefined,
      terminalCorteCred
    );
    expect(resForzado2.status).toBe(403);

    // 3. Manipulación de departamentoId en GET /inspecciones/periodos-disponibles
    const resForzadoPeriodos = await api(
      "GET",
      `/inspecciones/periodos-disponibles?departamentoId=${deptoMontadoId}`,
      "sutanito",
      undefined,
      terminalCorteCred
    );
    expect(resForzadoPeriodos.status).toBe(403);

    // 4. Intento de ver detalle de inspección de MONTADO desde terminal de CORTE
    const resForzadoDetalle = await api(
      "GET",
      `/inspecciones/${inspJuanitoMontadoId}`,
      "sutanito",
      undefined,
      terminalCorteCred
    );
    expect(resForzadoDetalle.status).toBe(403);
  });

  // =========================================================================
  // ESCENARIO 7: ADMIN y COORD consultan cualquier depto sin restricción
  // =========================================================================
  it("Escenario 7: ADMIN y COORD tienen acceso global irrestricto a todos los departamentos", async () => {
    // ADMIN consulta CORTE, MONTADO y AVIOS libremente
    const rAdminCorte = await api("GET", `/inspecciones?periodo=hoy&departamentoId=${deptoCorteId}`, "admin");
    expect(rAdminCorte.status).toBe(200);

    const rAdminMontado = await api("GET", `/inspecciones?periodo=hoy&departamentoId=${deptoMontadoId}`, "admin");
    expect(rAdminMontado.status).toBe(200);

    const rAdminAvios = await api("GET", `/inspecciones?periodo=hoy&departamentoId=${deptoAviosId}`, "admin");
    expect(rAdminAvios.status).toBe(200);

    // COORD consulta CORTE, MONTADO y AVIOS libremente
    const rCoordCorte = await api("GET", `/inspecciones?periodo=hoy&departamentoId=${deptoCorteId}`, "coord");
    expect(rCoordCorte.status).toBe(200);

    const rCoordMontado = await api("GET", `/inspecciones?periodo=hoy&departamentoId=${deptoMontadoId}`, "coord");
    expect(rCoordMontado.status).toBe(200);

    // Incluso si ADMIN o COORD envían una credencial de terminal de CORTE, su alcance no se restringe
    const rAdminConTerm = await api(
      "GET",
      `/inspecciones?periodo=hoy&departamentoId=${deptoMontadoId}`,
      "admin",
      undefined,
      terminalCorteCred
    );
    expect(rAdminConTerm.status).toBe(200);
  });

  // =========================================================================
  // ESCENARIO 8: Los registros preservan al usuario creador (inspectorId)
  // =========================================================================
  it("Escenario 8: Preservación de trazabilidad: el campo inspectorId / inspector.usuario refleja fielmente al creador", async () => {
    // Consultar el detalle de la inspección creada por Juanito
    const cabeceraDb = await prisma.inspeccionCabecera.findUnique({
      where: { id: inspJuanitoCorteId },
      include: { inspector: true },
    });

    expect(cabeceraDb).toBeDefined();
    expect(cabeceraDb!.inspectorId).toBe(juanitoId);
    expect(cabeceraDb!.creadoPor).toBe(juanitoId);
    expect(cabeceraDb!.inspector.usuario).toBe("t_juanito_insp");

    // Consultar via API como Sutanito y comprobar que la información de Juanito se conserva
    const resApi = await api(
      "GET",
      `/inspecciones/${inspJuanitoCorteId}`,
      "sutanito",
      undefined,
      terminalCorteCred
    );

    expect(resApi.status).toBe(200);
    const data = resApi.json.data;
    expect(data.inspectorId).toBe(juanitoId);
    expect(data.inspector.id).toBe(juanitoId);
    expect(data.inspector.usuario).toBe("t_juanito_insp");
  });
});

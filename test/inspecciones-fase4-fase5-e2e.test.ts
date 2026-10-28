import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { securityService } from "../src/modules/auth/services/security.service";
import type { Express } from "express";

/**
 * Fases 4 y 5 — Captura operativa (idempotencia, reglas de lote/defectos/pares, concurrencia)
 * e historial/trazabilidad (alcance por permisos, filtros, paginación, detalle, borrado lógico y recuperación).
 */
describe("Fases 4 y 5 E2E: Captura operativa, historial y trazabilidad", () => {
  let app: Express;
  let server: any;
  let baseUrl: string;

  const tokens: Record<string, string> = {};
  const usuarios: Record<string, number> = {};
  let deptoMontadoId: number;
  let terminalId: number;
  let terminalCred: string;
  let lote: { id: number; lote: string; cantidad: number };
  let defectoOk: { id: number; clave: number };
  let defectoOk2: { id: number; clave: number };
  let defectoNoPermitido: { id: number; clave: number };
  let inspeccionPropiaId: number;
  let detallePropioId: number;
  let inspeccionAjenaId: number;

  const api = async (method: string, path: string, who: string | null, body?: unknown, extra: Record<string, string> = {}) => {
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

  const capturar = (detalles: any[], key?: string, who = "inspector", cred = terminalCred, loteCodigo = lote.lote) =>
    api(
      "POST",
      "/inspecciones",
      who,
      { lote: loteCodigo, detalles },
      { "x-terminal-credential": cred, ...(key ? { "Idempotency-Key": key } : {}) }
    );

  const asegurarUsuario = async (usuario: string, rolCodigo: string) => {
    const rol = await prisma.rol.findUnique({ where: { codigo: rolCodigo } });
    const passwordHash = securityService.hashPassword("TestPass123!");
    let u = await prisma.usuario.findFirst({ where: { usuario } });
    if (!u) {
      u = await prisma.usuario.create({
        data: { usuario, nombre: `${usuario} nombre`, passwordHash, rolId: rol!.id, estado: "ACTIVO" },
      });
    } else {
      u = await prisma.usuario.update({ where: { id: u.id }, data: { passwordHash, estado: "ACTIVO", rolId: rol!.id } });
    }
    const login = await api("POST", "/auth/login", null, { usuario, password: "TestPass123!" });
    return { id: u.id, token: login.json.data.accessToken as string };
  };

  beforeAll(async () => {
    app = createApp();
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const montado = await prisma.departamento.findFirst({ where: { codigo: "MONTADO", estado: "ACTIVO" } });
    deptoMontadoId = montado!.id;

    const login = await api("POST", "/auth/login", null, { usuario: "admin", password: "Deadmau6" });
    tokens.superadmin = login.json.data.accessToken;

    for (const [clave, usuario, rol] of [
      ["inspector", "test_insp_f45", "INSPECTOR"],
      ["inspector2", "test_insp2_f45", "INSPECTOR"],
      ["admin", "test_admin_f45", "ADMIN"],
      ["coord", "test_coord_f45", "COORD"],
    ] as const) {
      const r = await asegurarUsuario(usuario, rol);
      tokens[clave] = r.token;
      usuarios[clave] = r.id;
    }

    const t = await api("POST", "/terminales", "superadmin", { nombre: `PC-F45-${Date.now()}`, departamentoId: deptoMontadoId });
    terminalId = t.json.data.terminal.id;
    terminalCred = t.json.data.credencial;

    const l = await prisma.produccionLote.findFirst({
      where: { estado: "ACTIVO", eliminadoEn: null, cantidad: { gte: 5 } },
      orderBy: { id: "desc" },
    });
    if (!l) throw new Error("No hay lote activo con cantidad >= 5 para las pruebas");
    lote = { id: l.id, lote: l.lote, cantidad: Math.floor(Number(l.cantidad)) };

    const permitidos = await prisma.defectoEtapa.findMany({
      where: { departamentoId: deptoMontadoId, permitido: true, defecto: { activo: true, eliminadoEn: null } },
      include: { defecto: true },
      take: 2,
      orderBy: { id: "asc" },
    });
    if (permitidos.length < 2) throw new Error("Se requieren 2 defectos permitidos en MONTADO");
    defectoOk = { id: permitidos[0]!.defectoId, clave: permitidos[0]!.defecto.clave };
    defectoOk2 = { id: permitidos[1]!.defectoId, clave: permitidos[1]!.defecto.clave };

    const np = await prisma.defecto.findFirst({
      where: {
        activo: true,
        eliminadoEn: null,
        etapas: { none: { departamentoId: deptoMontadoId, permitido: true } },
      },
    });
    if (!np) throw new Error("No existe un defecto no permitido en MONTADO para la prueba");
    defectoNoPermitido = { id: np.id, clave: np.clave };

    // Registro ajeno (otro inspector) insertado directamente para probar el alcance de consulta
    const ajena = await prisma.inspeccionCabecera.create({
      data: {
        folio: `TEST-AJENA-${Date.now()}`,
        loteId: lote.id,
        inspectorId: usuarios.inspector2!,
        departamentoAuditoriaId: deptoMontadoId,
        terminalId,
        estado: "RECHAZADO",
        detalles: {
          create: [{ defectoId: defectoOk.id, defDeptoId: deptoMontadoId, paresDefectuosos: 1 }],
        },
      },
    });
    inspeccionAjenaId = ajena.id;
  });

  afterAll(() => {
    server?.close();
  });

  // ======================= FASE 4 =======================
  describe("Fase 4 — captura", () => {
    it("F4-1. Lote inexistente se rechaza (404) sin crear registros", async () => {
      const antes = await prisma.inspeccionCabecera.count();
      const r = await capturar([{ defectoId: defectoOk.id, paresDefectuosos: 1 }], undefined, "inspector", terminalCred, "LOTE-NO-EXISTE-999");
      expect(r.status).toBe(404);
      expect(await prisma.inspeccionCabecera.count()).toBe(antes);
    });

    it("F4-2. Defecto no permitido para la etapa de la terminal se rechaza (400)", async () => {
      const r = await capturar([{ defectoId: defectoNoPermitido.id, paresDefectuosos: 1 }]);
      expect(r.status).toBe(400);
    });

    it("F4-3. Defectos duplicados en una misma captura se rechazan (400)", async () => {
      const r = await capturar([
        { defectoId: defectoOk.id, paresDefectuosos: 1 },
        { defectoId: defectoOk.id, paresDefectuosos: 2 },
      ]);
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.json)).toContain("duplicados");
    });

    it("F4-4. Pares defectuosos mayores a la cantidad del lote se rechazan (400)", async () => {
      const r = await capturar([{ defectoId: defectoOk.id, paresDefectuosos: lote.cantidad + 1 }]);
      expect(r.status).toBe(400);
    });

    it("F4-5. Cuerpo con departamentoAuditoriaId falso: se ignora y se usa el de la terminal", async () => {
      const res = await fetch(`${baseUrl}/api/v1/inspecciones`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokens.inspector}`,
          "x-terminal-credential": terminalCred,
        },
        body: JSON.stringify({
          lote: lote.lote,
          departamentoAuditoriaId: 999999,
          detalles: [{ defectoId: defectoOk.id, paresDefectuosos: 1 }],
        }),
      });
      const json = (await res.json()) as any;
      expect(res.status).toBe(201);
      expect(json.data.departamentoAuditoriaId).toBe(deptoMontadoId);
      expect(json.data.terminal.id).toBe(terminalId);
      inspeccionPropiaId = json.data.id;
      detallePropioId = json.data.detalles[0].id;
    });

    it("F4-6. Idempotency-Key inválida se rechaza (400)", async () => {
      const r = await capturar([{ defectoId: defectoOk.id, paresDefectuosos: 1 }], "corta");
      expect(r.status).toBe(400);
    });

    it("F4-7. Reintento con la misma clave devuelve la misma inspección y no duplica", async () => {
      const key = `idem-secuencial-${Date.now()}`;
      const r1 = await capturar([{ defectoId: defectoOk.id, paresDefectuosos: 1 }], key);
      const r2 = await capturar([{ defectoId: defectoOk.id, paresDefectuosos: 1 }], key);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(200);
      expect(r2.headers.get("idempotent-replayed")).toBe("true");
      expect(r2.json.data.id).toBe(r1.json.data.id);
      expect(await prisma.inspeccionCabecera.count({ where: { claveIdempotencia: key } })).toBe(1);
    });

    it("F4-8. Envíos simultáneos con la misma clave producen una sola inspección", async () => {
      const key = `idem-concurrente-${Date.now()}`;
      const rs = await Promise.all(
        [1, 2, 3, 4].map(() => capturar([{ defectoId: defectoOk2.id, paresDefectuosos: 1 }], key))
      );
      for (const r of rs) expect([200, 201]).toContain(r.status);
      expect(new Set(rs.map((r) => r.json.data.id)).size).toBe(1);
      expect(await prisma.inspeccionCabecera.count({ where: { claveIdempotencia: key } })).toBe(1);
    });

    it("F4-9. Capturas simultáneas sin clave obtienen folios únicos (reintento ante colisión)", async () => {
      const rs = await Promise.all(
        [1, 2, 3, 4, 5].map(() => capturar([{ defectoId: defectoOk.id, paresDefectuosos: 1 }]))
      );
      for (const r of rs) expect(r.status).toBe(201);
      expect(new Set(rs.map((r) => r.json.data.folio)).size).toBe(5);
    });

    it("F4-10. SUPER_ADMIN, ADMIN y COORD siguen sin poder capturar (403)", async () => {
      for (const who of ["superadmin", "admin", "coord"]) {
        const r = await capturar([{ defectoId: defectoOk.id, paresDefectuosos: 1 }], undefined, who);
        expect(r.status).toBe(403);
      }
    });
  });

  // ======================= FASE 5 =======================
  describe("Fase 5 — historial y trazabilidad", () => {
    it("F5-1. Sin autenticación el historial se rechaza (401)", async () => {
      expect((await api("GET", "/inspecciones", null)).status).toBe(401);
      expect((await api("GET", `/inspecciones/${inspeccionPropiaId}`, null)).status).toBe(401);
    });

    it("F5-2. INSPECTOR solo ve sus propias inspecciones aunque pida otro inspectorId", async () => {
      const r = await api("GET", `/inspecciones?periodo=todos&inspectorId=${usuarios.inspector2}&limit=200`, "inspector");
      expect(r.status).toBe(200);
      expect(r.json.data.items.length).toBeGreaterThan(0);
      expect(r.json.data.items.every((i: any) => i.usuario?.includes("test_insp_f45") || i.usuario === "test_insp_f45 nombre")).toBe(true);
      expect(r.json.data.items.some((i: any) => i.inspeccionId === inspeccionAjenaId)).toBe(false);
    });

    it("F5-3. ADMIN y COORD consultan el historial general e incluyen registros de ambos inspectores", async () => {
      for (const who of ["admin", "coord"]) {
        const r = await api("GET", `/inspecciones?periodo=todos&terminalId=${terminalId}&limit=200`, who);
        expect(r.status).toBe(200);
        const ids = new Set(r.json.data.items.map((i: any) => i.inspeccionId));
        expect(ids.has(inspeccionAjenaId)).toBe(true);
        expect(ids.has(inspeccionPropiaId)).toBe(true);
      }
    });

    it("F5-4. Filtros combinados: terminal + lote + defecto + inspector + departamento + rango de fechas", async () => {
      const hoy = new Date().toISOString().slice(0, 10);
      const q = new URLSearchParams({
        terminalId: String(terminalId),
        lote: lote.lote,
        defectoClave: String(defectoOk.clave),
        inspectorId: String(usuarios.inspector),
        departamentoAuditoriaId: String(deptoMontadoId),
        fechaDesde: hoy,
        fechaHasta: hoy,
        limit: "200",
      });
      const r = await api("GET", `/inspecciones?${q}`, "admin");
      expect(r.status).toBe(200);
      expect(r.json.data.items.length).toBeGreaterThan(0);
      for (const i of r.json.data.items) {
        expect(i.terminalId).toBe(terminalId);
        expect(i.lote).toBe(lote.lote);
        expect(i.defectoClave).toBe(defectoOk.clave);
      }
      // Una combinación excluyente no devuelve filas
      const vacio = await api("GET", `/inspecciones?terminalId=${terminalId}&inspectorId=${usuarios.coord}&periodo=todos`, "admin");
      expect(vacio.json.data.items.length).toBe(0);
    });

    it("F5-5. Filtro por clasificación se conserva junto con defectoClave", async () => {
      const def = await prisma.defecto.findUnique({ where: { id: defectoOk.id } });
      const otra = def!.clasificacion === "CRITICO" ? "MENOR" : "CRITICO";
      const r = await api(
        "GET",
        `/inspecciones?periodo=todos&defectoClave=${defectoOk.clave}&clasificacion=${otra}&terminalId=${terminalId}`,
        "admin"
      );
      expect(r.status).toBe(200);
      expect(r.json.data.items.length).toBe(0);
    });

    it("F5-6. Paginación determinista y página fuera de rango", async () => {
      const base = `/inspecciones?periodo=todos&terminalId=${terminalId}&limit=2`;
      const p1 = await api("GET", `${base}&page=1`, "admin");
      const p2 = await api("GET", `${base}&page=2`, "admin");
      expect(p1.json.data.items.length).toBe(2);
      const ids1 = p1.json.data.items.map((i: any) => i.id);
      const ids2 = p2.json.data.items.map((i: any) => i.id);
      expect(ids1.some((id: number) => ids2.includes(id))).toBe(false);
      expect(ids1[0]).toBeGreaterThan(ids1[1]);
      const fuera = await api("GET", `${base}&page=99999`, "admin");
      expect(fuera.status).toBe(200);
      expect(fuera.json.data.items.length).toBe(0);
    });

    it("F5-7. Filtros inválidos se rechazan (400) sin filtrar detalles internos", async () => {
      for (const qs of [
        "fechaDesde=2026-13-45",
        "fechaDesde=hoy",
        "fechaDesde=2026-10-10&fechaHasta=2026-10-01",
        "fechaDesde=2020-01-01&fechaHasta=2026-01-01",
        "limit=1000",
        "page=0",
        "terminalId=abc",
        "clasificacion=GRAVE",
      ]) {
        const r = await api("GET", `/inspecciones?${qs}`, "admin");
        expect(r.status).toBe(400);
        expect(JSON.stringify(r.json)).not.toMatch(/prisma|SELECT|stack/i);
      }
    });

    it("F5-8. Detalle completo para ADMIN: cabecera, defectos, terminal, usuario, origen WEB y trazabilidad", async () => {
      const r = await api("GET", `/inspecciones/${inspeccionPropiaId}`, "admin");
      expect(r.status).toBe(200);
      const d = r.json.data;
      expect(d.id).toBe(inspeccionPropiaId);
      expect(d.terminal.id).toBe(terminalId);
      expect(d.inspector.id).toBe(usuarios.inspector);
      expect(d.lote.lote).toBe(lote.lote);
      expect(d.detalles.length).toBeGreaterThan(0);
      expect(d.origen).toBe("WEB");
      expect(Array.isArray(d.trazabilidad)).toBe(true);
      expect(d.trazabilidad.some((e: any) => e.accion === "INSPECCION_REGISTRADA")).toBe(true);
      // Sin datos de autenticación
      expect(JSON.stringify(d)).not.toMatch(/credencial|passwordHash/i);
    });

    it("F5-9. INSPECTOR: detalle propio sí (sin trazabilidad), ajeno no (404), eliminados no (403)", async () => {
      const propio = await api("GET", `/inspecciones/${inspeccionPropiaId}`, "inspector");
      expect(propio.status).toBe(200);
      expect(propio.json.data.trazabilidad).toBeUndefined();
      const ajeno = await api("GET", `/inspecciones/${inspeccionAjenaId}`, "inspector");
      expect(ajeno.status).toBe(404);
      const elim = await api("GET", `/inspecciones/${inspeccionPropiaId}?incluirEliminados=true`, "inspector");
      expect(elim.status).toBe(403);
      const listaElim = await api("GET", "/inspecciones?soloEliminados=true", "inspector");
      expect(listaElim.status).toBe(403);
    });

    it("F5-10. Detalle inexistente 404 y id inválido 400", async () => {
      expect((await api("GET", "/inspecciones/99999999", "admin")).status).toBe(404);
      expect((await api("GET", "/inspecciones/abc", "admin")).status).toBe(400);
    });

    it("F5-11. Catálogo de inspectores solo con alcance general", async () => {
      expect((await api("GET", "/inspecciones/inspectores", "inspector")).status).toBe(403);
      expect((await api("GET", "/inspecciones/inspectores", "admin")).status).toBe(200);
    });

    it("F5-12. Eliminar defecto sin permiso 'defectos.eliminar' se rechaza (403) para INSPECTOR, ADMIN y COORD", async () => {
      for (const who of ["inspector", "admin", "coord"]) {
        const r = await api("POST", `/inspecciones/detalles/${detallePropioId}/cancelar`, who, { motivo: "Intento sin permiso" });
        expect(r.status).toBe(403);
      }
      const intacto = await prisma.inspeccionDetalle.findUnique({ where: { id: detallePropioId } });
      expect(intacto!.eliminadoEn).toBeNull();
    });

    it("F5-13. Eliminación lógica exige motivo, registra motivo/usuario y se audita", async () => {
      const sinMotivo = await api("POST", `/inspecciones/detalles/${detallePropioId}/cancelar`, "superadmin", {});
      expect(sinMotivo.status).toBe(400);
      const corto = await api("POST", `/inspecciones/detalles/${detallePropioId}/cancelar`, "superadmin", { motivo: "ab" });
      expect(corto.status).toBe(400);

      const motivo = "Captura duplicada por error del operador";
      const ok = await api("POST", `/inspecciones/detalles/${detallePropioId}/cancelar`, "superadmin", { motivo });
      expect(ok.status).toBe(200);

      const fila = await prisma.inspeccionDetalle.findUnique({ where: { id: detallePropioId } });
      expect(fila).not.toBeNull(); // nunca borrado físico
      expect(fila!.eliminadoEn).not.toBeNull();
      expect(fila!.eliminadoMotivo).toBe(motivo);
      expect(fila!.eliminadoPor).not.toBeNull();

      const evento = await prisma.registroAuditoria.findFirst({
        where: { accion: "DEFECTO_INSPECCION_ELIMINADO", entidadId: String(detallePropioId) },
        orderBy: { id: "desc" },
      });
      expect(evento).not.toBeNull();
      expect(evento!.motivo).toBe(motivo);
      expect(evento!.usuarioId).not.toBeNull();

      const otra = await api("POST", `/inspecciones/detalles/${detallePropioId}/cancelar`, "superadmin", { motivo });
      expect(otra.status).toBe(404);
    });

    it("F5-14. El defecto eliminado no aparece en el historial normal; solo con permiso en soloEliminados", async () => {
      const normal = await api("GET", `/inspecciones?periodo=todos&terminalId=${terminalId}&limit=200`, "admin");
      expect(normal.json.data.items.some((i: any) => i.id === detallePropioId)).toBe(false);

      expect((await api("GET", "/inspecciones?soloEliminados=true", "admin")).status).toBe(403);
      const elim = await api("GET", `/inspecciones?soloEliminados=true&terminalId=${terminalId}&limit=200`, "superadmin");
      expect(elim.status).toBe(200);
      const fila = elim.json.data.items.find((i: any) => i.id === detallePropioId);
      expect(fila).toBeDefined();
      expect(fila.eliminadoMotivo).toContain("duplicada");

      const detalleConElim = await api("GET", `/inspecciones/${inspeccionPropiaId}?incluirEliminados=true`, "superadmin");
      expect(detalleConElim.json.data.detalles.some((d: any) => d.id === detallePropioId)).toBe(true);
      const detalleSinElim = await api("GET", `/inspecciones/${inspeccionPropiaId}`, "superadmin");
      expect(detalleSinElim.json.data.detalles.some((d: any) => d.id === detallePropioId)).toBe(false);
    });

    it("F5-15. Recuperación: requiere permiso y motivo, restaura el registro y se audita", async () => {
      expect((await api("POST", `/inspecciones/detalles/${detallePropioId}/recuperar`, "admin", { motivo: "Sin permiso" })).status).toBe(403);
      expect((await api("POST", `/inspecciones/detalles/${detallePropioId}/recuperar`, "superadmin", {})).status).toBe(400);

      const motivo = "Eliminación realizada por equivocación";
      const ok = await api("POST", `/inspecciones/detalles/${detallePropioId}/recuperar`, "superadmin", { motivo });
      expect(ok.status).toBe(200);

      const fila = await prisma.inspeccionDetalle.findUnique({ where: { id: detallePropioId } });
      expect(fila!.eliminadoEn).toBeNull();
      expect(fila!.eliminadoMotivo).toBeNull();

      const evento = await prisma.registroAuditoria.findFirst({
        where: { accion: "DEFECTO_INSPECCION_RECUPERADO", entidadId: String(detallePropioId) },
      });
      expect(evento).not.toBeNull();
      expect(evento!.motivo).toBe(motivo);

      expect((await api("POST", `/inspecciones/detalles/${detallePropioId}/recuperar`, "superadmin", { motivo })).status).toBe(404);

      const traza = await api("GET", `/inspecciones/${inspeccionPropiaId}`, "admin");
      const acciones = traza.json.data.trazabilidad.map((e: any) => e.accion);
      expect(acciones).toContain("DEFECTO_INSPECCION_ELIMINADO");
      expect(acciones).toContain("DEFECTO_INSPECCION_RECUPERADO");
    });

    it("F5-16. La auditoría de la captura no almacena la credencial de terminal ni tokens", async () => {
      const eventos = await prisma.registroAuditoria.findMany({
        where: { entidad: "inspeccion_cabecera", entidadId: String(inspeccionPropiaId) },
      });
      expect(eventos.length).toBeGreaterThan(0);
      const texto = JSON.stringify(eventos);
      expect(texto).not.toContain(terminalCred);
      expect(texto).not.toContain(tokens.inspector!);
    });

    it("F5-17. La consulta del historial no genera eventos de auditoría de escritura", async () => {
      const antes = await prisma.registroAuditoria.count();
      await api("GET", `/inspecciones?periodo=todos&limit=5`, "admin");
      await api("GET", `/inspecciones/${inspeccionPropiaId}`, "admin");
      expect(await prisma.registroAuditoria.count()).toBe(antes);
    });
  });
});

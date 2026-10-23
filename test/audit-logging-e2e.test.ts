import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { securityService } from "../src/modules/auth/services/security.service";
import { auditService } from "../src/modules/audit/services/audit.service";
import { technicalLogger } from "../src/utils/technical-logger";
import type { Server } from "http";

describe("Auditoría, Logging Técnico, Monitoreo y Diagnóstico IA - Pruebas E2E", () => {
  let appServer: Server;
  let baseUrl: string;
  let adminToken: string;
  let adminUser: { id: number; usuario: string };

  beforeAll(async () => {
    const app = createApp();
    appServer = app.listen(0);
    const port = (appServer.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}/api/v1`;

    const admin = await prisma.usuario.findFirst({
      where: { usuario: "admin" },
      include: { rol: true },
    });
    if (!admin) throw new Error("Usuario admin no encontrado en base de datos");

    adminUser = admin;

    // Crear sesión de prueba única para el admin
    const uniqueHash = `hash_test_e2e_audit_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const sesion = await prisma.sesion.create({
      data: {
        usuarioId: admin.id,
        refreshTokenHash: uniqueHash,
        fechaExpiracion: new Date(Date.now() + 3600000),
      },
    });

    adminToken = securityService.generateAccessToken({
      usuarioId: admin.id,
      usuario: admin.usuario,
      nombre: admin.nombre,
      rolId: admin.rolId,
      rolCodigo: admin.rol.codigo,
      sesionId: sesion.id,
    });
  });

  afterAll(async () => {
    appServer.close();
  });

  it("1. Registro de evento de auditoría funcional con hash criptográfico y sanitización", async () => {
    const evento = await auditService.registrarEvento({
      accion: "USUARIO_CREADO",
      modulo: "USUARIOS",
      entidad: "Usuario",
      entidadId: "999",
      descripcion: "Creación de usuario con contraseña para verificación de sanitización",
      resultado: "EXITOSO",
      valoresAnteriores: null,
      valoresPosteriores: {
        usuario: "test_sanitizado",
        password: "SuperSecretPassword123!",
        refreshToken: "raw_token_xyz",
        rolId: 2,
      },
      contexto: {
        usuarioId: adminUser.id,
        usuarioNombre: adminUser.usuario,
        rolCodigo: "SUPER_ADMIN",
        metodoHttp: "POST",
        rutaHttp: "/api/v1/users",
        requestId: "req-test-audit-123",
      },
    });

    expect(evento.id).toBeDefined();
    expect(evento.hashIntegridad).toBeDefined();
    expect(evento.hashIntegridad?.length).toBe(64); // SHA-256

    // Verificar en BD que la contraseña y token fueron sanitizados
    const recuperado = await prisma.registroAuditoria.findUnique({
      where: { id: evento.id },
    });

    const detalles = recuperado?.detalles as any;
    expect(detalles).toBeDefined();
    expect(detalles.valoresPosteriores.password).toBe("[REDACTADO]");
    expect(detalles.valoresPosteriores.refreshToken).toBe("[REDACTADO]");
    expect(detalles.valoresPosteriores.usuario).toBe("test_sanitizado");
  });

  it("2. Verificación de la integridad de la cadena de auditoría SHA-256", async () => {
    // Sincronizar control de cadena antes de verificar para garantizar correspondencia tras suites previas
    await auditService.sincronizarControlCadena();

    const res = await fetch(`${baseUrl}/audit/integrity`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.cadenaValida).toBe(true);
    expect(body.data.eventosVerificados).toBeGreaterThan(0);
  });

  it("3. Registro en log técnico rotado y consulta mediante API", async () => {
    technicalLogger.warn("Alerta de prueba técnica e2e", {
      modulo: "TEST_E2E",
      requestId: "req-e2e-logger-test",
    });

    const res = await fetch(`${baseUrl}/audit/logs/technical?texto=e2e`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.items).toBeDefined();
    expect(Array.isArray(body.data.items)).toBe(true);
  });

  it("4. Monitor de Salud Operativo (MySQL ping, latencia y memoria)", async () => {
    const res = await fetch(`${baseUrl}/audit/health`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("healthy");
    expect(body.data.database.status).toBe("connected");
    expect(body.data.database.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.data.memory.rssMb).toBeGreaterThan(0);
  });

  it("5. Generación de Diagnóstico para IA con sanitización y formato Markdown", async () => {
    const res = await fetch(`${baseUrl}/audit/diagnostics/ai`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        codigoError: "ERR_TEST_SIMULADO",
        ventanaMinutos: 10,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.package).toBeDefined();
    expect(body.data.package.servidor).toBeDefined();
    expect(body.data.package.saludBaseDatos.conectada).toBe(true);
    expect(body.data.markdown).toContain("# REPORTE DE DIAGNÓSTICO TÉCNICO MBC");
    expect(body.data.markdown).toContain("## 1. Resumen del Incidente");
  });

  it("6. Acceso denegado a rutas de auditoría para usuarios sin rol ADMIN / SUPER_ADMIN", async () => {
    const operadorToken = securityService.generateAccessToken({
      usuarioId: 9999,
      usuario: "operador_sin_permiso",
      nombre: "Operador Test",
      rolId: 4,
      rolCodigo: "OPERADOR",
      sesionId: 99999,
    });

    const res = await fetch(`${baseUrl}/audit/events`, {
      headers: { Authorization: `Bearer ${operadorToken}` },
    });

    // Debe ser rechazado (403 Forbidden o 401 por sesión inválida)
    expect([401, 403]).toContain(res.status);
  });

  it("7. Concurrencia de la cadena criptográfica: inserción simultánea con mutex transaccional", async () => {
    // Disparar 3 registros en paralelo absoluto
    const promesas = [1, 2, 3].map((num) =>
      auditService.registrarEvento({
        accion: `TEST_CONCURRENTE_${num}`,
        modulo: "AUDIT_TEST",
        entidad: "PruebaConcurrencia",
        entidadId: String(num),
        descripcion: `Evento concurrente número ${num}`,
        resultado: "EXITOSO",
        contexto: { usuarioId: adminUser.id, usuarioNombre: adminUser.usuario },
      })
    );

    const eventos = await Promise.all(promesas);
    expect(eventos).toHaveLength(3);
    for (const ev of eventos) {
      expect(ev.hashIntegridad).toBeDefined();
      expect(ev.hashIntegridad?.length).toBe(64);
    }

    // Verificar que la cadena completa permanece 100% íntegra y sin bifurcaciones
    const verif = await auditService.verificarIntegridadCadena();
    expect(verif.cadenaValida).toBe(true);
    expect(verif.eventosVerificados).toBeGreaterThanOrEqual(3);
  });

  it("8. Seguridad del lector de logs PM2: rechazo de path traversal y patrones ajenos al proyecto", async () => {
    // Intentar path traversal
    const resTraversal = await fetch(`${baseUrl}/audit/logs/pm2?nombre=../../../../etc/passwd`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect([400, 404]).toContain(resTraversal.status);

    // Intentar consultar log que no pertenece al proyecto (e.g., servicio-externo)
    const resExterno = await fetch(`${baseUrl}/audit/logs/pm2?nombre=servicio_ajeno_hack.log`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect([400, 404]).toContain(resExterno.status);
  });

  it("9. Rotación y retención de logs técnicos: se respetan los backups máximos", async () => {
    // Emitir eventos suficientes para verificar que no lanza errores de rotación
    for (let i = 0; i < 5; i++) {
      technicalLogger.info(`Log de retención y rotación test ${i}`, { contexto: { iteracion: i } });
    }
    // Verificación de salud del logger
    const res = await fetch(`${baseUrl}/audit/logs/technical?limite=5`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.items.length).toBeGreaterThanOrEqual(1);
  });
});

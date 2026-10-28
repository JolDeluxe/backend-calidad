import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { securityService } from "../src/modules/auth/services/security.service";
import type { Express } from "express";

describe("Fase 2 E2E: Ciclo de vida de terminales, autorización estricta y recuperación OTP", () => {
  let app: Express;
  let server: any;
  let baseUrl: string;

  // Tokens de autenticación
  let superAdminToken: string;
  let adminToken: string;
  let inspectorToken: string;
  let inspectorUserId: number;

  let deptoCorteId: number;
  let deptoMontadoId: number;

  beforeAll(async () => {
    app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Obtener departamentos activos (Corte y Montado)
    const deptoCorte = await prisma.departamento.findFirst({
      where: { codigo: "CORTE", estado: "ACTIVO" },
    });
    const deptoMontado = await prisma.departamento.findFirst({
      where: { codigo: "MONTADO", estado: "ACTIVO" },
    });

    if (!deptoCorte || !deptoMontado) {
      throw new Error("Departamentos de prueba no encontrados en la base de datos.");
    }
    deptoCorteId = deptoCorte.id;
    deptoMontadoId = deptoMontado.id;

    // 1. Iniciar sesión como SUPER_ADMIN
    const loginSuper = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: "admin", password: "Deadmau6" }),
    });
    const superData = (await loginSuper.json()) as any;
    expect(superData.success).toBe(true);
    superAdminToken = superData.data.accessToken;

    // 2. Crear o encontrar usuario ADMIN
    const passwordHashValida = securityService.hashPassword("TestPass123!");
    let adminUser = await prisma.usuario.findFirst({
      where: { usuario: "test_admin_phase2" },
      include: { rol: true },
    });
    const adminRol = await prisma.rol.findUnique({ where: { codigo: "ADMIN" } });
    if (!adminUser && adminRol) {
      adminUser = await prisma.usuario.create({
        data: {
          usuario: "test_admin_phase2",
          nombre: "Test Admin Phase 2",
          passwordHash: passwordHashValida,
          rolId: adminRol.id,
          estado: "ACTIVO",
        },
        include: { rol: true },
      });
    } else if (adminUser) {
      await prisma.usuario.update({
        where: { id: adminUser.id },
        data: { passwordHash: passwordHashValida, estado: "ACTIVO" },
      });
    }

    // 3. Crear o encontrar usuario INSPECTOR
    let inspectorUser = await prisma.usuario.findFirst({
      where: { usuario: "test_inspector_phase2" },
      include: { rol: true },
    });
    const inspectorRol = await prisma.rol.findUnique({ where: { codigo: "INSPECTOR" } });
    if (!inspectorUser && inspectorRol) {
      inspectorUser = await prisma.usuario.create({
        data: {
          usuario: "test_inspector_phase2",
          nombre: "Test Inspector Phase 2",
          passwordHash: passwordHashValida,
          rolId: inspectorRol.id,
          estado: "ACTIVO",
        },
        include: { rol: true },
      });
    } else if (inspectorUser) {
      await prisma.usuario.update({
        where: { id: inspectorUser.id },
        data: { passwordHash: passwordHashValida, estado: "ACTIVO" },
      });
    }
    inspectorUserId = inspectorUser!.id;

    // Login HTTP real para obtener tokens y sesiones de ADMIN e INSPECTOR
    const loginAdminRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: "test_admin_phase2", password: "TestPass123!" }),
    });
    const adminData = (await loginAdminRes.json()) as any;
    expect(adminData.success).toBe(true);
    adminToken = adminData.data.accessToken;

    const loginInspRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: "test_inspector_phase2", password: "TestPass123!" }),
    });
    const inspData = (await loginInspRes.json()) as any;
    expect(inspData.success).toBe(true);
    inspectorToken = inspData.data.accessToken;

    // Crear terminal base para toda la suite de pruebas
    const resTerminalBase = await fetch(`${baseUrl}/api/v1/terminales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({
        nombre: `PC-BASE-PHASE2-${Date.now()}`,
        departamentoId: deptoCorteId,
      }),
    });
    const terminalData = (await resTerminalBase.json()) as any;
    createdTerminalId = terminalData.data.terminal.id;
    createdTerminalCredencial = terminalData.data.credencial;
  });

  afterAll(async () => {
    if (server) {
      server.close();
    }
  });

  let createdTerminalId: number;
  let createdTerminalCredencial: string;
  const terminalTestNombre = `PC-PHASE2-${Date.now()}`;

  it("1. SUPER_ADMIN crea y vincula una nueva terminal física presencialmente", async () => {
    const res = await fetch(`${baseUrl}/api/v1/terminales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({
        nombre: terminalTestNombre,
        departamentoId: deptoCorteId,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.terminal).toBeDefined();
    expect(body.data.terminal.nombre).toBe(terminalTestNombre);
    expect(body.data.credencial).toBeDefined(); // Entrega la credencial en texto plano una sola vez
    expect(typeof body.data.credencial).toBe("string");

    createdTerminalId = body.data.terminal.id;
    createdTerminalCredencial = body.data.credencial;

    // Verificar en BD que la credencial almacenada sea un HASH y no el texto plano
    const terminalEnDb = await prisma.terminal.findUnique({
      where: { id: createdTerminalId },
    });
    expect(terminalEnDb?.credencialHash).not.toBe(createdTerminalCredencial);
    expect(terminalEnDb?.credencialHash.length).toBe(64); // SHA-256 hex string
  });

  it("2. Autorización estricta: ADMIN e INSPECTOR no pueden gestionar terminales (403)", async () => {
    // Intento con ADMIN
    const resAdmin = await fetch(`${baseUrl}/api/v1/terminales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        nombre: `PC-HACK-${Date.now()}`,
        departamentoId: deptoCorteId,
      }),
    });
    expect(resAdmin.status).toBe(403);

    // Intento con INSPECTOR
    const resInspector = await fetch(`${baseUrl}/api/v1/terminales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorToken}`,
      },
      body: JSON.stringify({
        nombre: `PC-HACK-INSPECTOR-${Date.now()}`,
        departamentoId: deptoCorteId,
      }),
    });
    expect(resInspector.status).toBe(403);
  });

  it("3. Consultar estado de vinculación (/estado) con credencial válida e inválida", async () => {
    // Sin header
    const resSinHeader = await fetch(`${baseUrl}/api/v1/terminales/estado`);
    expect(resSinHeader.status).toBe(200);
    const bodySin = (await resSinHeader.json()) as any;
    expect(bodySin.data.vinculada).toBe(false);

    // Con credencial inválida
    const resInvalida = await fetch(`${baseUrl}/api/v1/terminales/estado`, {
      headers: { "x-terminal-credential": "credencial_falsa_que_no_existe_123" },
    });
    expect(resInvalida.status).toBe(200);
    const bodyInvalida = (await resInvalida.json()) as any;
    expect(bodyInvalida.data.vinculada).toBe(false);

    // Con credencial válida
    const resValida = await fetch(`${baseUrl}/api/v1/terminales/estado`, {
      headers: { "x-terminal-credential": createdTerminalCredencial },
    });
    expect(resValida.status).toBe(200);
    const bodyValida = (await resValida.json()) as any;
    expect(bodyValida.data.vinculada).toBe(true);
    expect(bodyValida.data.terminal.id).toBe(createdTerminalId);
    expect(bodyValida.data.terminal.departamentoId).toBe(deptoCorteId);
  });

  it("4. SUPER_ADMIN reasigna departamento de la terminal con motivo auditado", async () => {
    const res = await fetch(`${baseUrl}/api/v1/terminales/${createdTerminalId}/departamento`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({
        departamentoId: deptoMontadoId,
        motivo: "Reubicación física de estación por reconfiguración de línea",
      }),
    });

    const body = (await res.json()) as any;
    if (res.status !== 200) {
      console.error("DEBUG TEST 4 FAILED:", JSON.stringify(body));
    }
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.departamentoId).toBe(deptoMontadoId);

    // Verificar en BD que el cambio ocurrió y que quedó registro de auditoría
    const auditEvent = await prisma.registroAuditoria.findFirst({
      where: {
        accion: "TERMINAL_REASIGNADA",
        entidadId: String(createdTerminalId),
      },
      orderBy: { id: "desc" },
    });
    expect(auditEvent).not.toBeNull();
    const detalles = auditEvent?.detalles as any;
    expect(detalles?.descripcion).toContain("reasignada");
  });

  it("5. SUPER_ADMIN solicita código de recuperación OTP de 6 dígitos", async () => {
    const res = await fetch(`${baseUrl}/api/v1/terminales/${createdTerminalId}/solicitar-recuperacion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${superAdminToken}`,
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.codigo).toBeDefined();
    expect(/^\d{6}$/.test(body.data.codigo)).toBe(true); // Exactamente 6 dígitos
    expect(body.data.terminalId).toBe(createdTerminalId);

    // Verificar en BD que el código se guardó hasheado (HMAC-SHA256) y NUNCA en texto plano
    const otpDb = await prisma.terminalRecuperacionCodigo.findFirst({
      where: { terminalId: createdTerminalId },
      orderBy: { id: "desc" },
    });
    expect(otpDb).not.toBeNull();
    expect(otpDb?.codigoHash).not.toBe(body.data.codigo);
    expect(otpDb?.codigoHash.length).toBe(64); // 64 caracteres hex
    expect(otpDb?.usadoEn).toBeNull();
  });

  it("6. Solicitar un segundo código OTP invalida atómicamente el anterior", async () => {
    // Primera llamada
    const res1 = await fetch(`${baseUrl}/api/v1/terminales/${createdTerminalId}/solicitar-recuperacion`, {
      method: "POST",
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    const body1 = (await res1.json()) as any;
    const codigo1 = body1.data.codigo;

    // Segunda llamada
    const res2 = await fetch(`${baseUrl}/api/v1/terminales/${createdTerminalId}/solicitar-recuperacion`, {
      method: "POST",
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    const body2 = (await res2.json()) as any;
    const codigo2 = body2.data.codigo;

    expect(codigo1).not.toBe(codigo2);

    // Canjear el código 1 debe fallar (fue invalidado / expirado atómicamente)
    const resCanjeViejo = await fetch(`${baseUrl}/api/v1/terminales/canjear-recuperacion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigo: codigo1 }),
    });
    expect([400, 401]).toContain(resCanjeViejo.status); // Expirado/inválido
  });

  it("7. Canje de código OTP válido desde la PC física rota credencial y entrega la nueva", async () => {
    // Generamos código fresco
    const resOtp = await fetch(`${baseUrl}/api/v1/terminales/${createdTerminalId}/solicitar-recuperacion`, {
      method: "POST",
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    const { data: { codigo } } = (await resOtp.json()) as any;

    const resCanje = await fetch(`${baseUrl}/api/v1/terminales/canjear-recuperacion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigo }),
    });

    expect(resCanje.status).toBe(200);
    const bodyCanje = (await resCanje.json()) as any;
    expect(bodyCanje.success).toBe(true);
    expect(bodyCanje.data.credencial).toBeDefined();
    expect(bodyCanje.data.credencial).not.toBe(createdTerminalCredencial); // Nueva credencial
    const nuevaCredencial = bodyCanje.data.credencial;

    // La vieja credencial ya no es válida en /estado
    const checkVieja = await fetch(`${baseUrl}/api/v1/terminales/estado`, {
      headers: { "x-terminal-credential": createdTerminalCredencial },
    });
    const bodyVieja = (await checkVieja.json()) as any;
    expect(bodyVieja.data.vinculada).toBe(false);

    // La nueva credencial sí es válida en /estado
    const checkNueva = await fetch(`${baseUrl}/api/v1/terminales/estado`, {
      headers: { "x-terminal-credential": nuevaCredencial },
    });
    const bodyNueva = (await checkNueva.json()) as any;
    expect(bodyNueva.data.vinculada).toBe(true);
    expect(bodyNueva.data.terminal.id).toBe(createdTerminalId);

    // Actualizamos variable de referencia
    createdTerminalCredencial = nuevaCredencial;
  });

  it("8. Intento de reutilizar un código OTP ya canjeado es rechazado (400)", async () => {
    // Generamos código
    const resOtp = await fetch(`${baseUrl}/api/v1/terminales/${createdTerminalId}/solicitar-recuperacion`, {
      method: "POST",
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    const { data: { codigo } } = (await resOtp.json()) as any;

    // Primer canje (exitoso)
    const canje1 = await fetch(`${baseUrl}/api/v1/terminales/canjear-recuperacion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigo }),
    });
    expect(canje1.status).toBe(200);

    // Segundo canje (mismo código)
    const canje2 = await fetch(`${baseUrl}/api/v1/terminales/canjear-recuperacion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigo }),
    });
    expect([400, 401]).toContain(canje2.status); // Ya usado
  });

  it("9. Límite de 3 intentos fallidos bloquea el código OTP", async () => {
    // Generar código
    const resOtp = await fetch(`${baseUrl}/api/v1/terminales/${createdTerminalId}/solicitar-recuperacion`, {
      method: "POST",
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    const { data: { codigo } } = (await resOtp.json()) as any;

    // Simulamos que en BD encontramos el registro para probar intentos incrementales
    // Enviamos un código diferente pero probamos el límite en el registro
    // Para probar el límite exacto sobre el registro, usamos 3 intentos fallidos con hash simulado
    const otpDb = await prisma.terminalRecuperacionCodigo.findFirst({
      where: { terminalId: createdTerminalId, usadoEn: null },
      orderBy: { id: "desc" },
    });
    expect(otpDb).not.toBeNull();

    // Actualizamos intentosFallidos a 3 manualmente para verificar que canjearlo aún con código correcto falle
    await prisma.terminalRecuperacionCodigo.update({
      where: { id: otpDb!.id },
      data: { intentosFallidos: 3 },
    });

    const canjeConLimite = await fetch(`${baseUrl}/api/v1/terminales/canjear-recuperacion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigo }),
    });
    expect([400, 401]).toContain(canjeConLimite.status);
    const errBody = (await canjeConLimite.json()) as any;
    expect(errBody.message).toContain("límite");
  });

  it("10. Concurrencia: Dos canjes simultáneos del mismo código OTP solo permiten un ganador", async () => {
    // Generar nuevo código fresco
    const resOtp = await fetch(`${baseUrl}/api/v1/terminales/${createdTerminalId}/solicitar-recuperacion`, {
      method: "POST",
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    const { data: { codigo } } = (await resOtp.json()) as any;

    // Disparar dos peticiones POST en paralelo exacto
    const [resA, resB] = await Promise.all([
      fetch(`${baseUrl}/api/v1/terminales/canjear-recuperacion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigo }),
      }),
      fetch(`${baseUrl}/api/v1/terminales/canjear-recuperacion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigo }),
      }),
    ]);

    const statuses = [resA.status, resB.status];
    // Uno de ellos debe ser 200 y el otro debe ser rechazado (400 o 401)
    expect(statuses).toContain(200);
    expect(statuses.some((s) => s === 400 || s === 401)).toBe(true);
  });

  it("11. Revocación de terminal la marca INACTIVA y bloquea validación (/estado) y capturas", async () => {
    // SUPER_ADMIN revoca la terminal
    const resRevocar = await fetch(`${baseUrl}/api/v1/terminales/${createdTerminalId}/revocar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({
        motivo: "Terminal retirada de planta por mantenimiento preventivo",
      }),
    });

    expect(resRevocar.status).toBe(200);
    const bodyRevocar = (await resRevocar.json()) as any;
    expect(bodyRevocar.data.estado).toBe("INACTIVO");
    expect(bodyRevocar.data.fechaRevocacion).not.toBeNull();

    // /estado ahora reporta vinculada: false
    const resEstado = await fetch(`${baseUrl}/api/v1/terminales/estado`, {
      headers: { "x-terminal-credential": createdTerminalCredencial },
    });
    const bodyEstado = (await resEstado.json()) as any;
    expect(bodyEstado.data.vinculada).toBe(false);

    // Intentar solicitar OTP sobre una terminal revocada falla
    const resOtpRevocada = await fetch(
      `${baseUrl}/api/v1/terminales/${createdTerminalId}/solicitar-recuperacion`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${superAdminToken}` },
      },
    );
    expect(resOtpRevocada.status).toBe(400);
  });

  it("12. Auditoría: En ningún momento se registran credenciales planas ni códigos OTP en la bitácora", async () => {
    const eventos = await prisma.registroAuditoria.findMany({
      where: {
        accion: { in: ["TERMINAL_CREADA", "TERMINAL_REASIGNADA", "TERMINAL_RECUPERACION_SOLICITADA", "TERMINAL_RECUPERACION_CANJEADA", "TERMINAL_REVOCADA"] },
        terminalId: createdTerminalId,
      },
    });

    expect(eventos.length).toBeGreaterThan(0);
    for (const evt of eventos) {
      const dump = JSON.stringify(evt);
      // No debe contener la credencial en texto plano
      expect(dump).not.toContain(createdTerminalCredencial);
      // No debe contener códigos de 6 dígitos que coincidan con formato OTP plano en valoresPosteriores
      if (evt.detalles) {
        const detalles = evt.detalles as any;
        if (detalles.valoresPosteriores) {
          expect(detalles.valoresPosteriores.codigo).toBeUndefined();
          expect(detalles.valoresPosteriores.credencial).toBeUndefined();
        }
      }
    }
  });
});

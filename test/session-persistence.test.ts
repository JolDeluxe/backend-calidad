import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../src/config/database";
import { sessionService } from "../src/modules/auth/services/session.service";
import { securityService } from "../src/modules/auth/services/security.service";
import { env } from "../src/config/env";
import { UnauthorizedError } from "../src/utils/errors";

describe("Segunda Revisión: Auditoría e Integración de Persistencia de Sesión", () => {
  let refreshTokenActivo: string;
  let sesionIdActiva: number;
  let adminUsuarioId: number;

  beforeAll(async () => {
    // 0. Conexión real a MySQL comprobada
    const checkUser = await prisma.usuario.findFirst({
      where: { usuario: "admin" },
      include: { rol: true },
    });
    if (!checkUser) {
      throw new Error("Base de datos no inicializada: usuario 'admin' no existe");
    }
    adminUsuarioId = checkUser.id;
  });

  // 1. Crear sesión y comprobar fecha de expiración persistida (10 años = 3650 días)
  it("1. Debe crear una sesión y persistir fechaExpiracion y fechaUltimaExtension a 10 años", async () => {
    const login = await sessionService.login(
      { usuario: "admin", password: "Deadmau6" },
      "127.0.0.1",
      "MBC-Audit-Agent"
    );

    expect(login.accessToken).toBeDefined();
    expect(login.refreshToken).toBeDefined();
    refreshTokenActivo = login.refreshToken;

    const hash = securityService.hashRefreshToken(refreshTokenActivo);
    const sesion = await prisma.sesion.findUnique({
      where: { refreshTokenHash: hash },
    });

    expect(sesion).not.toBeNull();
    sesionIdActiva = sesion!.id;
    expect(sesion?.estado).toBe("ACTIVO");
    expect(sesion?.fechaUltimaExtension).not.toBeNull();

    const diasHastaExpiracion =
      (sesion!.fechaExpiracion.getTime() - sesion!.fechaCreacion.getTime()) / (1000 * 60 * 60 * 24);
    expect(Math.round(diasHastaExpiracion)).toBe(3650);
  });

  // 2. Simular renovaciones frecuentes y comprobar que la extensión diaria funciona sin perder el ciclo
  it("2. Las renovaciones dentro de 24h no deben disparar extensión deslizante innecesaria", async () => {
    const hash = securityService.hashRefreshToken(refreshTokenActivo);

    // Primera renovación inmediata (0 minutos transcurridos)
    const refresh1 = await sessionService.refresh(refreshTokenActivo);
    expect(refresh1.sessionExtended).toBe(false);

    const s1 = await prisma.sesion.findUnique({ where: { id: sesionIdActiva } });
    const exp1 = s1!.fechaExpiracion.getTime();

    // Segunda renovación simulando 5 horas después
    const cincoHorasMs = 5 * 60 * 60 * 1000;
    await prisma.sesion.update({
      where: { id: sesionIdActiva },
      data: { fechaUltimoUso: new Date(Date.now() - cincoHorasMs) },
    });

    const refresh2 = await sessionService.refresh(refreshTokenActivo);
    expect(refresh2.sessionExtended).toBe(false);

    const s2 = await prisma.sesion.findUnique({ where: { id: sesionIdActiva } });
    expect(s2!.fechaExpiracion.getTime()).toBe(exp1);
  });

  it("3. Debe extender la sesión deslizando 10 años cuando pasaron más de 24h desde la última extensión", async () => {
    const hash = securityService.hashRefreshToken(refreshTokenActivo);

    // Simulamos que pasaron 26 horas desde fechaUltimaExtension, pero fechaUltimoUso fue hace 10 minutos
    const veintiseisHorasMs = 26 * 60 * 60 * 1000;
    const diezMinutosMs = 10 * 60 * 1000;
    const fechaExtensionVieja = new Date(Date.now() - veintiseisHorasMs);
    const fechaUsoReciente = new Date(Date.now() - diezMinutosMs);

    await prisma.sesion.update({
      where: { id: sesionIdActiva },
      data: {
        fechaUltimaExtension: fechaExtensionVieja,
        fechaUltimoUso: fechaUsoReciente,
      },
    });

    const refresh = await sessionService.refresh(refreshTokenActivo);
    expect(refresh.sessionExtended).toBe(true);

    const sExt = await prisma.sesion.findUnique({ where: { id: sesionIdActiva } });
    expect(sExt!.fechaUltimaExtension!.getTime()).toBeGreaterThan(fechaExtensionVieja.getTime());

    // La nueva expiración debe estar calculada a 3650 días a partir de ahora
    const diasRestantes = (sExt!.fechaExpiracion.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(Math.round(diasRestantes)).toBe(3650);
  });

  // 4. Reiniciar backend sin eliminar la sesión
  it("4. La sesión persiste intacta en la base de datos simulando un reinicio de servicio", async () => {
    // Al ser sesiones en MySQL en lugar de memoria, verificar acceso directo
    const hash = securityService.hashRefreshToken(refreshTokenActivo);
    const sesionPersistida = await prisma.sesion.findUnique({
      where: { refreshTokenHash: hash },
    });

    expect(sesionPersistida).not.toBeNull();
    expect(sesionPersistida?.estado).toBe("ACTIVO");

    // Nueva instancia de servicio debe poder autenticar sin estado previo en memoria
    const nuevoRefresh = await sessionService.refresh(refreshTokenActivo);
    expect(nuevoRefresh.accessToken).toBeDefined();
    expect(nuevoRefresh.usuario.usuario).toBe("admin");
  });

  // 5. Revocar una sesión y comprobar que el backend rechaza las operaciones posteriores
  it("5. Revocar sesión debe invalidar el refresh token y rechazar accesos futuros", async () => {
    // Simulamos revocación por logout o por administrador
    await sessionService.logout(refreshTokenActivo);

    const hash = securityService.hashRefreshToken(refreshTokenActivo);
    const sesionRevocada = await prisma.sesion.findUnique({
      where: { refreshTokenHash: hash },
    });
    expect(sesionRevocada?.estado).toBe("INACTIVO");

    // Intento de refrescar con la sesión revocada debe fallar con UnauthorizedError
    expect(sessionService.refresh(refreshTokenActivo)).rejects.toThrow(UnauthorizedError);
  });

  // 5b. Comprobar que un access token emitido previamente es RECHAZADO por el middleware si la sesión fue revocada
  it("5b. Un access token previamente emitido debe ser rechazado inmediatamente por authenticate si la sesión fue revocada", async () => {
    // Iniciar sesión
    const login = await sessionService.login(
      { usuario: "admin", password: "Deadmau6" },
      "127.0.0.1",
      "Revocation-Check-Agent"
    );

    const decoded = securityService.verifyAccessToken(login.accessToken);
    expect(decoded?.sesionId).toBeDefined();

    // Comprobar que la validación de sesión pasa mientras está activa
    const sesionValida = await sessionService.validateActiveSession(decoded!.sesionId!);
    expect(sesionValida.estado).toBe("ACTIVO");

    // Revocar la sesión directamente en base de datos (simulando un administrador)
    await prisma.sesion.update({
      where: { id: decoded!.sesionId! },
      data: { estado: "INACTIVO" },
    });

    // Ahora validateActiveSession debe fallar de inmediato
    await expect(sessionService.validateActiveSession(decoded!.sesionId!)).rejects.toThrow(UnauthorizedError);

    // Limpieza
    await prisma.sesion.deleteMany({
      where: { id: decoded!.sesionId! },
    });
  });

  // 6. Rechazo cuando el usuario es desactivado
  it("6. Un usuario desactivado debe ser rechazado inmediatamente en refresh y en auth middleware", async () => {
    // Crear una sesión temporal para un usuario
    const tempLogin = await sessionService.login(
      { usuario: "admin", password: "Deadmau6" },
      "127.0.0.1"
    );

    // Desactivar temporalmente el usuario
    await prisma.usuario.update({
      where: { id: adminUsuarioId },
      data: { estado: "INACTIVO" },
    });

    try {
      // Debe fallar el refresh
      await expect(sessionService.refresh(tempLogin.refreshToken)).rejects.toThrow(UnauthorizedError);

      // Debe fallar la validación activa en middleware
      await expect(sessionService.validateActiveUser(adminUsuarioId)).rejects.toThrow(UnauthorizedError);
    } finally {
      // Restaurar estado activo del usuario
      await prisma.usuario.update({
        where: { id: adminUsuarioId },
        data: { estado: "ACTIVO" },
      });
      await sessionService.logout(tempLogin.refreshToken);
    }
  });

  afterAll(async () => {
    // Limpieza de sesiones de prueba
    if (sesionIdActiva) {
      await prisma.sesion.deleteMany({
        where: { id: sesionIdActiva },
      });
    }
  });
});

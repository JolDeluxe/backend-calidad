import { Router } from "express";
import { sessionController } from "./controllers/session.controller";
import { validate } from "../../middlewares/validate";
import { authenticate, requireTerminal, requireRole } from "../../middlewares/auth";
import { loginSchema } from "./auth.schema";
import { offlineAuthService } from "./services/offline-auth.service";
import { sendSuccess } from "../../utils/response";
import { auditService } from "../audit/services/audit.service";

const router = Router();

router.post(
  "/login",
  validate({ body: loginSchema }),
  (req, res, next) => sessionController.login(req, res, next),
);

/**
 * Obtiene la lista de usuarios activos para el selector de login rápido.
 * Devuelve inspectores (para la vista general) y administrativos/coordinadores
 * (para el acceso de administración, incluyendo SUPER_ADMIN).
 * Endpoint público y ligero.
 */
router.get("/usuarios-login", async (_req, res, next) => {
  try {
    const usuarios = await prisma.usuario.findMany({
      where: { estado: "ACTIVO" },
      select: {
        id: true,
        usuario: true,
        nombre: true,
        rol: {
          select: {
            id: true,
            codigo: true,
            nombre: true,
          },
        },
      },
      orderBy: { nombre: "asc" },
    });

    const inspectores = usuarios.filter((u) => u.rol.codigo === "INSPECTOR");
    const administradores = usuarios.filter((u) => u.rol.codigo !== "INSPECTOR");

    return sendSuccess(
      res,
      { inspectores, administradores },
      "Usuarios para inicio de sesión obtenidos exitosamente",
    );
  } catch (error) {
    next(error);
  }
});

router.post(
  "/refresh",
  (req, res, next) => sessionController.refresh(req, res, next),
);

router.post(
  "/logout",
  (req, res, next) => sessionController.logout(req, res, next),
);

router.get(
  "/me",
  authenticate,
  (req, res, next) => sessionController.getMe(req, res, next),
);

/**
 * Emite una credencial criptográfica offline con vigencia exacta de 48 horas (172,800s).
 * Requiere inspector autenticado con rol INSPECTOR y estación física vinculada activa.
 */
router.post(
  "/offline-token",
  authenticate,
  requireRole(["INSPECTOR"]),
  requireTerminal,
  async (req, res, next) => {
    try {
      const user = req.user!;
      const terminal = req.terminal!;

      const offlineSession = offlineAuthService.generateOfflineToken({
        usuarioId: user.usuarioId,
        usuario: user.usuario,
        nombre: user.nombre,
        terminalId: terminal.id,
        terminalNombre: terminal.nombre,
        departamentoId: terminal.departamentoId,
      });

      // Auditoría de emisión de token offline (nunca registra el token completo en logs/auditoría)
      await auditService.registrarEvento({
        accion: "TOKEN_OFFLINE_EMITIDO",
        modulo: "AUTENTICACION_OFFLINE",
        entidad: "offline_session",
        entidadId: `${user.usuarioId}:${terminal.id}`,
        descripcion: `Token offline emitido para inspector '${user.usuario}' en terminal '${terminal.nombre}' con vigencia de 48h`,
        valoresPosteriores: {
          inspectorId: user.usuarioId,
          terminalId: terminal.id,
          terminalNombre: terminal.nombre,
          departamentoId: terminal.departamentoId,
          emitidoEn: offlineSession.emitidoEn,
          expiraEn: offlineSession.expiraEn,
          vigenciaSegundos: offlineSession.vigenciaSegundos,
        },
        contexto: {
          usuarioId: user.usuarioId,
          usuarioNombre: user.nombre,
          rolCodigo: user.rolCodigo,
          departamentoId: terminal.departamentoId,
          terminalId: terminal.id,
          ipOrigen: req.ip,
          agenteUsuario: req.headers["user-agent"],
          metodoHttp: req.method,
          rutaHttp: req.originalUrl,
        },
      });

      sendSuccess(
        res,
        {
          offlineToken: offlineSession.token,
          emitidoEn: offlineSession.emitidoEn,
          expiraEn: offlineSession.expiraEn,
          vigenciaSegundos: offlineSession.vigenciaSegundos,
          inspector: {
            id: user.usuarioId,
            usuario: user.usuario,
            nombre: user.nombre,
          },
          terminal: {
            id: terminal.id,
            nombre: terminal.nombre,
            departamentoId: terminal.departamentoId,
          },
        },
        "Token de autorización offline emitido exitosamente (vigencia 48 horas)",
      );
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Descarga y sincronización del catálogo de inspectores autorizados para operar offline
 * en la terminal física vinculada (`requireTerminal`).
 * Cada inspector activo con permiso efectivo `defectos.capturar` recibe su verificador
 * PBKDF2-HMAC-SHA256, su salt aleatorio único y su `offlineToken` firmado con vigencia de 48 horas.
 */
router.get(
  "/inspectores-offline",
  requireTerminal,
  async (req, res, next) => {
    try {
      const terminal = req.terminal!;
      const catalog = await offlineAuthService.getInspectoresOfflineCatalog(terminal);

      await auditService.registrarEvento({
        accion: "CATALOGO_INSPECTORES_OFFLINE_SINCRONIZADO",
        modulo: "AUTENTICACION_OFFLINE",
        entidad: "terminal_inspectores_offline",
        entidadId: String(terminal.id),
        descripcion: `Catálogo de ${catalog.inspectores.length} inspectores offline sincronizado para terminal '${terminal.nombre}'`,
        valoresPosteriores: {
          terminalId: terminal.id,
          terminalNombre: terminal.nombre,
          departamentoId: terminal.departamentoId,
          totalInspectores: catalog.inspectores.length,
          vigenciaSegundos: catalog.vigenciaSegundos,
        },
        contexto: {
          usuarioId: req.user?.usuarioId,
          usuarioNombre: req.user?.nombre ?? "SISTEMA_TERMINAL",
          rolCodigo: req.user?.rolCodigo ?? "TERMINAL",
          departamentoId: terminal.departamentoId,
          terminalId: terminal.id,
          ipOrigen: req.ip,
          agenteUsuario: req.headers["user-agent"],
          metodoHttp: req.method,
          rutaHttp: req.originalUrl,
        },
      });

      sendSuccess(
        res,
        catalog,
        "Catálogo de inspectores autorizados para modo offline recuperado exitosamente",
      );
    } catch (error) {
      next(error);
    }
  },
);

export const authRouter = router;

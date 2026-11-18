import { Router } from "express";
import {
  authenticate,
  requireRole,
  requirePermission,
  requireTerminal,
} from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import { terminalsService } from "../auth/services/terminals.service";
import { terminalsRecoveryService } from "./services/terminals-recovery.service";
import { permissionsService } from "../auth/services/permissions.service";
import { securityService } from "../auth/services/security.service";
import { auditService } from "../audit/services/audit.service";
import { sendSuccess, sendCreated } from "../../utils/response";
import { ForbiddenError, UnauthorizedError, NotFoundError } from "../../utils/errors";
import { prisma } from "../../config/database";
import {
  createTerminalSchema,
  reasignarTerminalSchema,
  renameTerminalSchema,
  updateTerminalDepartamentosSchema,
  revocarTerminalSchema,
  terminalIdParamSchema,
  solicitarRecuperacionSchema,
  canjearRecuperacionSchema,
  verificarAutorizacionSuperAdminSchema,
} from "./terminals.schema";
import { resolverLugarDeteccionTerminal } from "../inspecciones/utils/nomenclatura-defectos";

const router = Router();

// =========================================================================
// RUTAS OPERATIVAS Y DE TERMINAL FÍSICA
// =========================================================================

/**
 * Consulta el estado de vinculación de la terminal física actual.
 * Lee el header HTTP 'x-terminal-credential'.
 * Si es válida y activa, responde con la información pública de la terminal.
 * Si no viene el header o es inválida/revocada, responde { vinculada: false } sin lanzar 500.
 */
router.get("/estado", async (req, res) => {
  const credencial = req.headers["x-terminal-credential"] as string;
  if (!credencial) {
    return sendSuccess(res, { vinculada: false }, "Terminal no vinculada");
  }

  try {
    const terminal = await terminalsService.validateTerminal(credencial);
    return sendSuccess(
      res,
      {
        vinculada: true,
        terminal: {
          id: terminal.id,
          nombre: terminal.nombre,
          departamentoId: terminal.departamentoId,
          departamentoNombre: terminal.departamento.nombre,
          departamentoCodigo: terminal.departamento.codigo,
          numeroLineas: terminal.departamento.numeroLineas,
          departamentos: terminal.departamentosActivos,
          departamentosIds: terminal.departamentosIds,
          lugarDeteccion: terminal.lugarDeteccion,
          estado: terminal.estado,
        },
      },
      "Terminal vinculada y activa",
    );
  } catch (_error) {
    return sendSuccess(
      res,
      { vinculada: false },
      "Terminal no vinculada, inactiva o credencial inválida",
    );
  }
});

/**
 * Canje presencial de código OTP de 6 dígitos desde la estación de trabajo física.
 * Transacción atómica, sin autenticación de usuario previa.
 * Devuelve la nueva credencial una sola vez y actualiza el hash en MySQL.
 */
router.post(
  "/canjear-recuperacion",
  validate({ body: canjearRecuperacionSchema }),
  async (req, res, next) => {
    try {
      const { codigo } = req.body;
      const ip = req.ip || req.socket.remoteAddress;
      const userAgent = req.headers["user-agent"];

      const resultado = await terminalsRecoveryService.canjearCodigoRecuperacion({
        codigo,
        reqInfo: {
          ip,
          userAgent,
        },
      });

      sendSuccess(
        res,
        resultado,
        "Terminal vinculada exitosamente mediante código de recuperación",
      );
    } catch (error) {
      next(error);
    }
  },
);

// =========================================================================
// GESTIÓN DE TERMINALES (Exclusivo SUPER_ADMIN y permiso terminales.gestionar)
// =========================================================================

// Consultar terminales registradas (SUPER_ADMIN)
router.get(
  "/",
  authenticate,
  requireRole(["SUPER_ADMIN"]),
  requirePermission("terminales.consultar"),
  async (_req, res, next) => {
    try {
      const terminalesRaw = await prisma.terminal.findMany({
        include: {
          departamento: { select: { id: true, codigo: true, nombre: true, numeroLineas: true, estado: true } },
          departamentos: {
            where: { activo: true },
            include: {
              departamento: {
                select: { id: true, codigo: true, nombre: true, numeroLineas: true, estado: true },
              },
            },
            orderBy: [{ esPrincipal: "desc" }, { departamentoId: "asc" }],
          },
        },
        orderBy: { id: "asc" },
      });

      const terminales = terminalesRaw.map((t) => {
        const departamentosActivos = terminalsService.extractDepartamentosActivos(t);
        const lugarDeteccion = resolverLugarDeteccionTerminal({
          terminalNombre: t.nombre,
          departamentoPrincipalNombre: t.departamento.nombre,
          departamentosActivos,
        });
        return {
          ...t,
          departamentosActivos,
          departamentosIds: departamentosActivos.map((d) => d.departamentoId),
          lugarDeteccion,
        };
      });

      sendSuccess(res, terminales, "Terminales obtenidas exitosamente");
    } catch (error) {
      next(error);
    }
  },
);

// Registrar nueva terminal física (SUPER_ADMIN)
router.post(
  "/",
  authenticate,
  requireRole(["SUPER_ADMIN"]),
  requirePermission("terminales.gestionar"),
  validate({ body: createTerminalSchema }),
  async (req, res, next) => {
    try {
      const { nombre, departamentoId, departamentosIds } = req.body;
      const resultado = await terminalsService.createTerminal({
        nombre: nombre?.trim() || undefined,
        departamentoId: Number(departamentoId),
        departamentosIds: Array.isArray(departamentosIds)
          ? departamentosIds.map(Number)
          : undefined,
        usuarioAuditId: req.user?.usuarioId,
      });
      sendCreated(res, resultado, "Terminal vinculada exitosamente");
    } catch (error) {
      next(error);
    }
  },
);

// Sugerir nombre secuencial para terminal según departamento (SUPER_ADMIN)
router.get(
  "/sugerir-nombre",
  authenticate,
  requireRole(["SUPER_ADMIN"]),
  requirePermission("terminales.consultar"),
  async (req, res, next) => {
    try {
      const departamentoId = Number(req.query.departamentoId);
      if (!departamentoId || isNaN(departamentoId)) {
        return res.status(400).json({ success: false, message: "ID de departamento inválido" });
      }
      const nombreSugerido = await terminalsService.generateSequentialName(departamentoId);
      sendSuccess(res, { nombre: nombreSugerido }, "Nombre de terminal sugerido exitosamente");
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Listado de usuarios con rol SUPER_ADMIN activos para autorizaciones presenciales de contingencia.
 * Accesible para cualquier usuario autenticado en el sistema.
 */
router.get("/superadmins", authenticate, async (_req, res, next) => {
  try {
    const superadmins = await prisma.usuario.findMany({
      where: {
        estado: "ACTIVO",
        rol: { codigo: "SUPER_ADMIN" },
      },
      select: {
        id: true,
        nombre: true,
        usuario: true,
      },
      orderBy: { nombre: "asc" },
    });
    sendSuccess(res, superadmins, "SuperAdmins activos obtenidos exitosamente");
  } catch (error) {
    next(error);
  }
});

/**
 * Verificación presencial de contraseña de Super Administrador para contingencias o desvinculación forzada.
 * Registra auditoría con evidencia del autorizador y el usuario solicitante.
 */
router.post(
  "/verificar-autorizacion-superadmin",
  authenticate,
  validate({ body: verificarAutorizacionSuperAdminSchema }),
  async (req, res, next) => {
    try {
      const { superAdminId, password, accion, motivo, terminalId } = req.body;

      const superAdmin = await prisma.usuario.findFirst({
        where: {
          id: superAdminId,
          estado: "ACTIVO",
          rol: { codigo: "SUPER_ADMIN" },
        },
        include: { rol: true },
      });

      if (!superAdmin) {
        throw new NotFoundError("El Super Administrador especificado no existe o no se encuentra activo");
      }

      const passwordValida = securityService.verifyPassword(password, superAdmin.passwordHash);

      if (!passwordValida) {
        await auditService.registrarEvento({
          accion: "AUTORIZACION_SUPERADMIN_FALLIDA",
          modulo: "TERMINALES",
          entidad: "terminal",
          entidadId: terminalId ? String(terminalId) : undefined,
          descripcion: `Intento fallido de autorización presencial de SuperAdmin (${superAdmin.nombre}) para: ${accion}`,
          resultado: "RECHAZADO",
          motivo: "Contraseña incorrecta",
          contexto: {
            usuarioId: req.user?.usuarioId,
            terminalId: terminalId ? Number(terminalId) : undefined,
            metodoHttp: req.method,
            rutaHttp: req.originalUrl || req.url,
          },
          metadatos: {
            superAdminId: superAdmin.id,
            superAdminUsuario: superAdmin.usuario,
            accionSolicitada: accion,
            motivo,
          },
        });

        throw new UnauthorizedError("Contraseña de Super Administrador incorrecta");
      }

      await auditService.registrarEvento({
        accion: "AUTORIZACION_SUPERADMIN_PRESENCIAL",
        modulo: "TERMINALES",
        entidad: "terminal",
        entidadId: terminalId ? String(terminalId) : undefined,
        descripcion: `Autorización presencial otorgada por ${superAdmin.nombre} (${superAdmin.usuario}) para: ${accion}`,
        resultado: "EXITOSO",
        motivo: motivo || "Autorización presencial concedida",
        contexto: {
          usuarioId: req.user?.usuarioId,
          terminalId: terminalId ? Number(terminalId) : undefined,
          metodoHttp: req.method,
          rutaHttp: req.originalUrl || req.url,
        },
        metadatos: {
          superAdminId: superAdmin.id,
          superAdminUsuario: superAdmin.usuario,
          accionAutorizada: accion,
          motivo,
        },
      });

      sendSuccess(
        res,
        {
          autorizado: true,
          fechaAutorizacion: new Date().toISOString(),
          autorizador: {
            id: superAdmin.id,
            nombre: superAdmin.nombre,
            usuario: superAdmin.usuario,
          },
          accion,
        },
        "Autorización de Super Administrador confirmada exitosamente",
      );
    } catch (error) {
      next(error);
    }
  },
);

// Cambiar nombre visible personalizado de terminal (SUPER_ADMIN)
router.patch(
  "/:id/nombre",
  authenticate,
  requireRole(["SUPER_ADMIN"]),
  requirePermission("terminales.gestionar"),
  validate({
    params: terminalIdParamSchema,
    body: renameTerminalSchema,
  }),
  async (req, res, next) => {
    try {
      const terminalId = Number(req.params.id);
      const { nombre, motivo } = req.body;
      const actualizada = await terminalsService.renameTerminal({
        terminalId,
        nombre,
        motivo,
        usuarioAuditId: req.user?.usuarioId,
      });
      sendSuccess(res, actualizada, "Nombre de terminal actualizado exitosamente");
    } catch (error) {
      next(error);
    }
  },
);

// Actualizar departamentos asociados y departamento principal de una terminal (SUPER_ADMIN)
router.put(
  "/:id/departamentos",
  authenticate,
  requireRole(["SUPER_ADMIN"]),
  requirePermission("terminales.gestionar"),
  validate({
    params: terminalIdParamSchema,
    body: updateTerminalDepartamentosSchema,
  }),
  async (req, res, next) => {
    try {
      const terminalId = Number(req.params.id);
      const { departamentosIds, departamentoPrincipalId, motivo } = req.body;
      const actualizada = await terminalsService.updateTerminalDepartamentos({
        terminalId,
        departamentosIds: departamentosIds.map(Number),
        departamentoPrincipalId: Number(departamentoPrincipalId),
        motivo,
        usuarioAuditId: req.user?.usuarioId,
      });
      sendSuccess(
        res,
        actualizada,
        "Departamentos asociados a la terminal actualizados exitosamente",
      );
    } catch (error) {
      next(error);
    }
  },
);

// Reasignar departamento a terminal (SUPER_ADMIN - mantiene compatibilidad 1:N sincronizando tabla intermedia)
router.patch(
  "/:id/departamento",
  authenticate,
  requireRole(["SUPER_ADMIN"]),
  requirePermission("terminales.gestionar"),
  validate({
    params: terminalIdParamSchema,
    body: reasignarTerminalSchema,
  }),
  async (req, res, next) => {
    try {
      const terminalId = Number(req.params.id);
      const { departamentoId, motivo } = req.body;
      const nuevoDeptoId = Number(departamentoId);
      const motivoTexto = motivo?.trim() || "Reasignación de departamento de terminal";

      const actualizada = await prisma.$transaction(async (tx) => {
        const previa = await tx.terminal.findUnique({
          where: { id: terminalId },
          include: { departamento: true },
        });
        if (!previa) {
          throw new NotFoundError("Terminal no encontrada");
        }

        // Sincronizar en terminales_departamentos manteniendo exactamente 1 principal activo
        await tx.terminalDepartamento.updateMany({
          where: { terminalId, esPrincipal: true },
          data: { esPrincipal: false, actualizadoPor: req.user?.usuarioId ?? null },
        });

        await tx.terminalDepartamento.updateMany({
          where: { terminalId, departamentoId: { not: nuevoDeptoId }, activo: true },
          data: {
            activo: false,
            esPrincipal: false,
            actualizadoPor: req.user?.usuarioId ?? null,
          },
        });

        await tx.terminalDepartamento.upsert({
          where: {
            unique_terminal_departamento: {
              terminalId,
              departamentoId: nuevoDeptoId,
            },
          },
          create: {
            terminalId,
            departamentoId: nuevoDeptoId,
            esPrincipal: true,
            activo: true,
            creadoPor: req.user?.usuarioId ?? null,
            actualizadoPor: req.user?.usuarioId ?? null,
          },
          update: {
            esPrincipal: true,
            activo: true,
            actualizadoPor: req.user?.usuarioId ?? null,
          },
        });

        const updated = await tx.terminal.update({
          where: { id: terminalId },
          data: { departamentoId: nuevoDeptoId },
          include: {
            departamento: true,
            departamentos: {
              where: { activo: true },
              include: { departamento: true },
              orderBy: [{ esPrincipal: "desc" }, { departamentoId: "asc" }],
            },
          },
        });

        // Auditoría unificada centralizada
        await auditService.registrarEvento(
          {
            accion: "TERMINAL_REASIGNADA",
            modulo: "TERMINALES",
            entidad: "terminal",
            entidadId: String(terminalId),
            descripcion: `Terminal '${updated.nombre}' reasignada de departamento '${previa.departamento.nombre}' a '${updated.departamento.nombre}'`,
            motivo: motivoTexto,
            valoresAnteriores: {
              departamentoId: previa.departamentoId,
              departamentoNombre: previa.departamento.nombre,
            },
            valoresPosteriores: {
              departamentoId: updated.departamentoId,
              departamentoNombre: updated.departamento.nombre,
            },
            contexto: {
              usuarioId: req.user?.usuarioId,
              departamentoId: updated.departamentoId,
              terminalId,
            },
          },
          tx,
        );

        return updated;
      });

      sendSuccess(res, actualizada, "Terminal reasignada exitosamente");
    } catch (error) {
      next(error);
    }
  },
);

// Revocar/bloquear terminal (SUPER_ADMIN)
router.post(
  "/:id/revocar",
  authenticate,
  requireRole(["SUPER_ADMIN"]),
  requirePermission("terminales.gestionar"),
  validate({
    params: terminalIdParamSchema,
    body: revocarTerminalSchema,
  }),
  async (req, res, next) => {
    try {
      const terminalId = Number(req.params.id);
      const { motivo } = req.body || {};
      const motivoTexto = motivo?.trim() || "Revocación de terminal por administrador";
      const revocada = await terminalsService.revokeTerminal(
        terminalId,
        motivoTexto,
        req.user?.usuarioId,
      );
      sendSuccess(res, revocada, "Terminal revocada exitosamente");
    } catch (error) {
      next(error);
    }
  },
);

// Generar código de recuperación OTP para una terminal (SUPER_ADMIN)
router.post(
  "/:id/solicitar-recuperacion",
  authenticate,
  requireRole(["SUPER_ADMIN"]),
  requirePermission("terminales.gestionar"),
  validate({
    params: terminalIdParamSchema,
  }),
  async (req, res, next) => {
    try {
      const terminalId = Number(req.params.id);
      const resultado = await terminalsRecoveryService.solicitarCodigoRecuperacion({
        terminalId,
        usuarioAdminId: req.user!.usuarioId,
      });

      sendSuccess(
        res,
        resultado,
        "Código de recuperación temporal generado exitosamente. Válido por 15 minutos.",
      );
    } catch (error) {
      next(error);
    }
  },
);

// =========================================================================
// RUTA OPERATIVA DE CAPTURA DE DEFECTOS DEMO (Requiere Usuario + Terminal)
// =========================================================================
router.post(
  "/captura-defecto-demo",
  authenticate,
  requireTerminal,
  requirePermission("defectos.capturar"),
  async (req, res, next) => {
    try {
      const departamentoOperativoId = req.terminal!.departamentoId;

      // Un INSPECTOR puede capturar en cualquier terminal válida sin requerir alcance personal asignado
      const auditoria = await auditService.registrarEvento({
        accion: "DEFECTO_CAPTURADO_DEMO",
        modulo: "CALIDAD_OPERATIVA",
        entidad: "defecto",
        descripcion: `Captura de defecto operativa validada para departamento ${departamentoOperativoId}`,
        valoresAnteriores: null,
        valoresPosteriores: {
          departamentoValidadoServidor: departamentoOperativoId,
          datosCaptura: req.body.datos,
        },
        contexto: {
          usuarioId: req.user!.usuarioId,
          departamentoId: departamentoOperativoId,
          terminalId: req.terminal!.id,
          metodoHttp: req.method,
          rutaHttp: req.originalUrl || req.url,
        },
      });

      sendCreated(
        res,
        {
          mensaje: "Defecto procesado con departamento validado por el servidor",
          departamentoId: departamentoOperativoId,
          terminalId: req.terminal!.id,
          auditoriaId: auditoria.id,
        },
        "Captura exitosa",
      );
    } catch (error) {
      next(error);
    }
  },
);

export const terminalsRouter = router;

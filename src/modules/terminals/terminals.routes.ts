import { Router } from "express";
import { authenticate, requirePermission, requireTerminal } from "../../middlewares/auth";
import { terminalsService } from "../auth/services/terminals.service";
import { permissionsService } from "../auth/services/permissions.service";
import { auditService } from "../audit/services/audit.service";
import { sendSuccess, sendCreated } from "../../utils/response";
import { ForbiddenError } from "../../utils/errors";
import { prisma } from "../../config/database";

const router = Router();

// =========================================================================
// GESTIÓN DE TERMINALES (Requiere autenticación de usuario)
// =========================================================================

// Consultar terminales
router.get("/", authenticate, requirePermission("terminales.consultar"), async (_req, res, next) => {
  try {
    const terminales = await prisma.terminal.findMany({
      include: { departamento: { select: { id: true, codigo: true, nombre: true } } },
      orderBy: { id: "asc" },
    });
    sendSuccess(res, terminales, "Terminales obtenidas exitosamente");
  } catch (error) {
    next(error);
  }
});

// Registrar nueva terminal
router.post("/", authenticate, requirePermission("terminales.gestionar"), async (req, res, next) => {
  try {
    const { nombre, departamentoId } = req.body;
    const resultado = await terminalsService.createTerminal({
      nombre,
      departamentoId: Number(departamentoId),
      usuarioAuditId: req.user?.usuarioId,
    });
    sendCreated(res, resultado, "Terminal vinculada exitosamente");
  } catch (error) {
    next(error);
  }
});

// Reasignar departamento a terminal
router.patch("/:id/departamento", authenticate, requirePermission("terminales.gestionar"), async (req, res, next) => {
  try {
    const terminalId = Number(req.params.id);
    const { departamentoId, motivo } = req.body;

    const actualizada = await prisma.$transaction(async (tx) => {
      const previa = await tx.terminal.findUnique({
        where: { id: terminalId },
        include: { departamento: true },
      });

      const updated = await tx.terminal.update({
        where: { id: terminalId },
        data: { departamentoId: Number(departamentoId) },
        include: { departamento: true },
      });

      // Auditoría unificada centralizada
      await auditService.registrarEvento(
        {
          accion: "TERMINAL_REASIGNADA",
          modulo: "TERMINALES",
          entidad: "terminal",
          entidadId: String(terminalId),
          descripcion: `Terminal '${updated.nombre}' reasignada de departamento '${previa?.departamento.nombre}' a '${updated.departamento.nombre}'`,
          motivo,
          valoresAnteriores: {
            departamentoId: previa?.departamentoId,
            departamentoNombre: previa?.departamento.nombre,
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
        tx
      );

      return updated;
    });

    sendSuccess(res, actualizada, "Terminal reasignada exitosamente");
  } catch (error) {
    next(error);
  }
});

// Revocar/bloquear terminal
router.post("/:id/revocar", authenticate, requirePermission("terminales.gestionar"), async (req, res, next) => {
  try {
    const terminalId = Number(req.params.id);
    const { motivo } = req.body;
    const revocada = await terminalsService.revokeTerminal(
      terminalId,
      motivo || "Revocación administrativa",
      req.user?.usuarioId,
    );
    sendSuccess(res, revocada, "Terminal revocada exitosamente");
  } catch (error) {
    next(error);
  }
});

// =========================================================================
// RUTA OPERATIVA DE CAPTURA DE DEFECTOS (Requiere Usuario + Terminal)
// Demuestra que el departamento se toma de la terminal validada por el servidor
// y nunca del body enviado por el cliente.
// =========================================================================
router.post(
  "/captura-defecto-demo",
  authenticate,
  requireTerminal,
  requirePermission("defectos.capturar"),
  async (req, res, next) => {
    try {
      // 1. El departamento DEBE venir de la terminal validada en el servidor
      const departamentoOperativoId = req.terminal!.departamentoId;

      // 2. Verificar que el usuario tenga alcance sobre el departamento de la terminal
      const tieneAlcance = await permissionsService.hasDepartmentScope(
        req.user!.usuarioId,
        departamentoOperativoId,
      );

      if (!tieneAlcance) {
        throw new ForbiddenError(
          "El usuario no tiene alcance autorizado sobre el departamento de esta terminal",
        );
      }

      // 3. Auditoría de captura centralizada con hash
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

import { createHmac, randomBytes } from "node:crypto";
import { prisma } from "../../../config/database";
import { UnauthorizedError, NotFoundError, ConflictError } from "../../../utils/errors";
import { env } from "../../../config/env";
import { auditService } from "../../audit/services/audit.service";

export class TerminalsService {
  /**
   * Genera una credencial aleatoria segura para vinculación de navegador.
   */
  generateCredential(): string {
    return randomBytes(32).toString("hex");
  }

  /**
   * Hash SHA-256 de la credencial de terminal para almacenar en MySQL.
   */
  hashCredential(credencial: string): string {
    return createHmac("sha256", env.JWT_SECRET).update(credencial).digest("hex");
  }

  /**
   * Registra una nueva terminal asignada a un departamento.
   */
  async createTerminal(data: { nombre: string; departamentoId: number; usuarioAuditId?: number }) {
    const existente = await prisma.terminal.findUnique({
      where: { nombre: data.nombre },
    });
    if (existente) {
      throw new ConflictError("Ya existe una terminal con ese nombre administrativo");
    }

    const credencialPlana = this.generateCredential();
    const credencialHash = this.hashCredential(credencialPlana);

    // Transacción atómica: Creación de terminal y registro de auditoría encadenada
    return await prisma.$transaction(async (tx) => {
      const terminal = await tx.terminal.create({
        data: {
          nombre: data.nombre,
          departamentoId: data.departamentoId,
          credencialHash,
          estado: "ACTIVO",
        },
        include: { departamento: true },
      });

      // Auditoría unificada centralizada
      await auditService.registrarEvento(
        {
          accion: "TERMINAL_CREADA",
          modulo: "TERMINALES",
          entidad: "terminal",
          entidadId: String(terminal.id),
          descripcion: `Terminal '${terminal.nombre}' creada y vinculada al departamento '${terminal.departamento.nombre}'`,
          valoresAnteriores: null,
          valoresPosteriores: {
            nombre: terminal.nombre,
            departamentoId: terminal.departamentoId,
            departamentoNombre: terminal.departamento.nombre,
            estado: terminal.estado,
          },
          contexto: {
            usuarioId: data.usuarioAuditId,
            departamentoId: terminal.departamentoId,
            terminalId: terminal.id,
          },
        },
        tx
      );

      return {
        terminal: {
          id: terminal.id,
          nombre: terminal.nombre,
          departamento: terminal.departamento,
          estado: terminal.estado,
          fechaCreacion: terminal.fechaCreacion,
        },
        credencial: credencialPlana, // Se entrega una sola vez al vincular
      };
    });
  }

  /**
   * Valida la credencial de terminal enviada por el navegador en la cabecera HTTP.
   * La terminal debe estar ACTIVA y su departamento debe estar ACTIVO.
   */
  async validateTerminal(credencial: string) {
    if (!credencial) {
      throw new UnauthorizedError("Credencial de terminal no proporcionada");
    }

    const hash = this.hashCredential(credencial);
    const terminal = await prisma.terminal.findUnique({
      where: { credencialHash: hash },
      include: { departamento: true },
    });

    if (!terminal || terminal.estado !== "ACTIVO" || terminal.fechaRevocacion) {
      throw new UnauthorizedError("Terminal inválida, bloqueada o revocada");
    }

    if (terminal.departamento.estado !== "ACTIVO") {
      throw new UnauthorizedError("El departamento de la terminal se encuentra inactivo");
    }

    // Actualizar fecha de último acceso
    await prisma.terminal.update({
      where: { id: terminal.id },
      data: { fechaUltimoAcceso: new Date() },
    });

    return terminal;
  }

  /**
   * Bloquea o revoca una terminal vinculada.
   */
  async revokeTerminal(id: number, motivo: string, usuarioAuditId?: number) {
    const terminal = await prisma.terminal.findUnique({ where: { id } });
    if (!terminal) {
      throw new NotFoundError("Terminal no encontrada");
    }

    // Transacción atómica: Revocación y registro de auditoría encadenada
    return await prisma.$transaction(async (tx) => {
      const actualizada = await tx.terminal.update({
        where: { id },
        data: {
          estado: "INACTIVO",
          motivoBloqueo: motivo,
          fechaRevocacion: new Date(),
        },
      });

      // Auditoría unificada centralizada
      await auditService.registrarEvento(
        {
          accion: "TERMINAL_REVOCADA",
          modulo: "TERMINALES",
          entidad: "terminal",
          entidadId: String(id),
          descripcion: `Terminal #${id} revocada por motivo: '${motivo}'`,
          motivo,
          valoresAnteriores: {
            estado: terminal.estado,
            motivoBloqueo: terminal.motivoBloqueo,
          },
          valoresPosteriores: {
            estado: actualizada.estado,
            motivoBloqueo: actualizada.motivoBloqueo,
            fechaRevocacion: actualizada.fechaRevocacion,
          },
          contexto: {
            usuarioId: usuarioAuditId,
            departamentoId: terminal.departamentoId,
            terminalId: id,
          },
        },
        tx
      );

      return actualizada;
    });
  }
}

export const terminalsService = new TerminalsService();

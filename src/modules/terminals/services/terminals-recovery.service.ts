import { createHmac, randomInt } from "node:crypto";
import { prisma } from "../../../config/database";
import {
  NotFoundError,
  BadRequestError,
  UnauthorizedError,
  ConflictError,
} from "../../../utils/errors";
import { env } from "../../../config/env";
import { auditService } from "../../audit/services/audit.service";
import { terminalsService } from "../../auth/services/terminals.service";

export interface SolicitarRecuperacionResult {
  codigo: string;
  expiraEn: Date;
  terminalId: number;
  terminalNombre: string;
}

export interface CanjearRecuperacionResult {
  credencial: string;
  terminal: {
    id: number;
    nombre: string;
    departamentoId: number;
    departamentoNombre: string;
    departamentoCodigo: string;
    estado: string;
  };
}

export class TerminalsRecoveryService {
  /**
   * Genera un código OTP de 6 dígitos con formato uniforme (ej. "004812").
   */
  private generateRawCode(): string {
    return randomInt(0, 1000000).toString().padStart(6, "0");
  }

  /**
   * Calcula el hash criptográfico HMAC-SHA256 del código OTP.
   * Utiliza la clave secreta del servidor para evitar ataques de diccionario offline.
   */
  private hashOtpCode(code: string): string {
    return createHmac("sha256", env.JWT_SECRET).update(code.trim()).digest("hex");
  }

  /**
   * Solicita un código de recuperación temporal (Exclusivo SUPER_ADMIN).
   * Invalida atómicamente cualquier código activo anterior para esta terminal.
   */
  async solicitarCodigoRecuperacion(params: {
    terminalId: number;
    usuarioAdminId: number;
  }): Promise<SolicitarRecuperacionResult> {
    const { terminalId, usuarioAdminId } = params;

    const terminal = await prisma.terminal.findUnique({
      where: { id: terminalId },
      include: { departamento: true },
    });

    if (!terminal) {
      throw new NotFoundError("La terminal especificada no existe.");
    }

    if (terminal.estado !== "ACTIVO" || terminal.fechaRevocacion) {
      throw new BadRequestError(
        "No es posible generar código de recuperación: la terminal se encuentra inactiva o revocada."
      );
    }

    if (terminal.departamento.estado !== "ACTIVO") {
      throw new BadRequestError(
        "No es posible generar código de recuperación: el departamento asignado a la terminal está inactivo."
      );
    }

    const rawCode = this.generateRawCode();
    const codigoHash = this.hashOtpCode(rawCode);

    const now = new Date();
    // Expiración a 24 horas (1 día completo para facilitar la vinculación en planta)
    const expiraEn = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    return await prisma.$transaction(async (tx) => {
      // 1. Invalidar atómicamente códigos anteriores aún vigentes para esta terminal
      await tx.terminalRecuperacionCodigo.updateMany({
        where: {
          terminalId,
          usadoEn: null,
          expiraEn: { gt: now },
        },
        data: {
          expiraEn: now, // Marca de expiración inmediata
        },
      });

      // 2. Crear el nuevo registro protegido de código OTP
      await tx.terminalRecuperacionCodigo.create({
        data: {
          terminalId,
          codigoHash,
          creadoPor: usuarioAdminId,
          intentosFallidos: 0,
          maxIntentos: 3,
          expiraEn,
        },
      });

      // 3. Registrar auditoría encadenada (NUNCA se registra el código plano)
      await auditService.registrarEvento(
        {
          accion: "TERMINAL_RECUPERACION_SOLICITADA",
          modulo: "TERMINALES",
          entidad: "terminal",
          entidadId: String(terminal.id),
          descripcion: `Código de recuperación solicitado para terminal '${terminal.nombre}' por usuario ID ${usuarioAdminId}`,
          valoresAnteriores: null,
          valoresPosteriores: {
            terminalId: terminal.id,
            terminalNombre: terminal.nombre,
            expiraEn,
          },
          contexto: {
            usuarioId: usuarioAdminId,
            departamentoId: terminal.departamentoId,
            terminalId: terminal.id,
          },
        },
        tx
      );

      return {
        codigo: rawCode, // Se entrega una sola vez en memoria para el SUPER_ADMIN
        expiraEn,
        terminalId: terminal.id,
        terminalNombre: terminal.nombre,
      };
    });
  }

  /**
   * Canjea el código OTP desde la PC física.
   * Maneja concurrencia atómica, límite de intentos y rotación segura de credencial.
   */
  async canjearCodigoRecuperacion(params: {
    codigo: string;
    reqInfo?: {
      ip?: string;
      userAgent?: string;
    };
  }): Promise<CanjearRecuperacionResult> {
    const rawCode = params.codigo.trim();
    if (!/^\d{6}$/.test(rawCode)) {
      throw new BadRequestError("El formato del código debe ser de exactamente 6 dígitos numéricos.");
    }

    const codigoHash = this.hashOtpCode(rawCode);
    const now = new Date();

    return await prisma.$transaction(async (tx) => {
      // 1. Bloqueo pesimista a nivel de base de datos con FOR UPDATE para prevenir condición de carrera
      const lockedRows = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT id
        FROM terminales_recuperacion_codigos
        WHERE codigo_hash = ${codigoHash} AND usado_en IS NULL
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE
      `;

      if (!lockedRows || lockedRows.length === 0) {
        throw new UnauthorizedError("Código de recuperación inválido, expirado o ya utilizado.");
      }

      const lockedId = lockedRows[0].id;
      const otpRecord = await tx.terminalRecuperacionCodigo.findUnique({
        where: { id: lockedId },
        include: {
          terminal: {
            include: { departamento: true },
          },
        },
      });

      if (!otpRecord || otpRecord.usadoEn !== null) {
        throw new UnauthorizedError("Código de recuperación inválido, expirado o ya utilizado.");
      }

      // 2. Verificar si está expirado
      if (now > otpRecord.expiraEn) {
        throw new UnauthorizedError("El código de recuperación ha expirado.");
      }

      // 3. Verificar si excedió el número máximo de intentos fallidos
      if (otpRecord.intentosFallidos >= otpRecord.maxIntentos) {
        throw new UnauthorizedError("El código de recuperación ha sido bloqueado por superar el límite de intentos.");
      }

      // 4. Validar estado de la terminal
      const terminal = otpRecord.terminal;
      if (terminal.estado !== "ACTIVO" || terminal.fechaRevocacion) {
        throw new BadRequestError("La terminal asociada se encuentra inactiva o revocada.");
      }

      if (terminal.departamento.estado !== "ACTIVO") {
        throw new BadRequestError("El departamento de la terminal asociada está inactivo.");
      }

      // 5. Invalidador de uso único: Marcar como USADO
      await tx.terminalRecuperacionCodigo.update({
        where: { id: otpRecord.id },
        data: {
          usadoEn: now,
        },
      });

      // 6. Generar una NUEVA credencial criptográfica de terminal
      const nuevaCredencialPlana = terminalsService.generateCredential();
      const nuevoHash = terminalsService.hashCredential(nuevaCredencialPlana);

      // 7. Actualizar la terminal con la nueva credencial e invalidar la anterior
      const terminalActualizada = await tx.terminal.update({
        where: { id: terminal.id },
        data: {
          credencialHash: nuevoHash,
          fechaUltimoAcceso: now,
        },
        include: { departamento: true },
      });

      // 8. Registrar evento de auditoría
      await auditService.registrarEvento(
        {
          accion: "TERMINAL_RECUPERADA_EXITOSAMENTE",
          modulo: "TERMINALES",
          entidad: "terminal",
          entidadId: String(terminal.id),
          descripcion: `Terminal '${terminal.nombre}' recuperada y revinculada exitosamente mediante código OTP`,
          valoresAnteriores: null,
          valoresPosteriores: {
            terminalId: terminal.id,
            terminalNombre: terminal.nombre,
            departamentoId: terminal.departamentoId,
          },
          contexto: {
            usuarioId: otpRecord.creadoPor,
            departamentoId: terminal.departamentoId,
            terminalId: terminal.id,
            ipOrigen: params.reqInfo?.ip,
            agenteUsuario: params.reqInfo?.userAgent,
          },
        },
        tx
      );

      return {
        credencial: nuevaCredencialPlana,
        terminal: {
          id: terminalActualizada.id,
          nombre: terminalActualizada.nombre,
          departamentoId: terminalActualizada.departamentoId,
          departamentoNombre: terminalActualizada.departamento.nombre,
          departamentoCodigo: terminalActualizada.departamento.codigo,
          estado: terminalActualizada.estado,
        },
      };
    });
  }
}

export const terminalsRecoveryService = new TerminalsRecoveryService();

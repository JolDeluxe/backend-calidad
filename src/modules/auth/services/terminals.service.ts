import { createHmac, randomBytes } from "node:crypto";
import { prisma } from "../../../config/database";
import {
  UnauthorizedError,
  NotFoundError,
  ConflictError,
  BadRequestError,
} from "../../../utils/errors";
import { env } from "../../../config/env";
import { auditService } from "../../audit/services/audit.service";
import {
  resolverLugarDeteccionTerminal,
  type TerminalDepartamentoSnapshotItem,
} from "../../inspecciones/utils/nomenclatura-defectos";

export interface TerminalDepartamentoActivoInfo extends TerminalDepartamentoSnapshotItem {
  numeroLineas: number;
}

export class TerminalsService {
  /**
   * Genera una credencial aleatoria segura para vinculación de navegador.
   */
  generateCredential(): string {
    return randomBytes(32).toString("hex");
  }

  /**
   * Hash HMAC-SHA256 de la credencial de terminal para almacenar en MySQL.
   */
  hashCredential(credencial: string): string {
    return createHmac("sha256", env.JWT_SECRET).update(credencial).digest("hex");
  }

  /**
   * Normaliza la lista de departamentos activos asociados a una terminal,
   * garantizando fallback seguro al departamento principal si la terminal fue creada
   * directamente por Prisma en pruebas sin poblar la tabla intermedia.
   */
  extractDepartamentosActivos(terminal: {
    id: number;
    nombre: string;
    departamentoId: number;
    departamento: {
      id: number;
      codigo: string;
      nombre: string;
      numeroLineas?: number;
      estado?: string;
    };
    departamentos?: Array<{
      departamentoId: number;
      esPrincipal: boolean;
      activo: boolean;
      departamento: {
        id: number;
        codigo: string;
        nombre: string;
        numeroLineas?: number;
        estado?: string;
      };
    }>;
  }): TerminalDepartamentoActivoInfo[] {
    const asocs = (terminal.departamentos || []).filter(
      (td) => td.activo && (!td.departamento.estado || td.departamento.estado === "ACTIVO")
    );

    if (asocs.length === 0) {
      if (!terminal.departamento.estado || terminal.departamento.estado === "ACTIVO") {
        return [
          {
            departamentoId: terminal.departamento.id,
            codigo: terminal.departamento.codigo,
            nombre: terminal.departamento.nombre,
            numeroLineas: terminal.departamento.numeroLineas ?? 1,
            esPrincipal: true,
          },
        ];
      }
      return [];
    }

    const mapped = asocs.map((td) => ({
      departamentoId: td.departamento.id,
      codigo: td.departamento.codigo,
      nombre: td.departamento.nombre,
      numeroLineas: td.departamento.numeroLineas ?? 1,
      esPrincipal: td.esPrincipal || td.departamentoId === terminal.departamentoId,
    }));

    // Asegurar que el departamento principal esté incluido si está activo
    if (
      (!terminal.departamento.estado || terminal.departamento.estado === "ACTIVO") &&
      !mapped.some((m) => m.departamentoId === terminal.departamentoId)
    ) {
      mapped.unshift({
        departamentoId: terminal.departamento.id,
        codigo: terminal.departamento.codigo,
        nombre: terminal.departamento.nombre,
        numeroLineas: terminal.departamento.numeroLineas ?? 1,
        esPrincipal: true,
      });
    }

    return mapped.sort((a, b) => {
      if (a.esPrincipal !== b.esPrincipal) return a.esPrincipal ? -1 : 1;
      return a.departamentoId - b.departamentoId;
    });
  }

  /**
   * Genera el siguiente nombre secuencial administrativo para una terminal según su departamento.
   * Por ejemplo: PC-MONTADO-01, PC-MONTADO-02, etc.
   */
  async generateSequentialName(departamentoId: number): Promise<string> {
    const depto = await prisma.departamento.findUnique({
      where: { id: departamentoId },
    });
    if (!depto) {
      throw new NotFoundError("Departamento no encontrado");
    }

    const basePrefix = `PC-${depto.codigo.toUpperCase()}-`;
    const terminalesDepto = await prisma.terminal.findMany({
      where: {
        departamentoId,
        nombre: { startsWith: basePrefix },
      },
      select: { nombre: true },
    });

    let maxNum = 0;
    for (const t of terminalesDepto) {
      const match = t.nombre.match(new RegExp(`^${basePrefix}(\\d+)$`));
      if (match && match[1]) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }

    const nextNum = (maxNum + 1).toString().padStart(2, "0");
    return `${basePrefix}${nextNum}`;
  }

  /**
   * Registra una nueva terminal asignada a uno o varios departamentos.
   * Conserva `departamentoId` como el departamento principal obligatorio.
   */
  async createTerminal(data: {
    nombre?: string;
    departamentoId: number;
    departamentosIds?: number[];
    usuarioAuditId?: number;
  }) {
    let finalNombre = data.nombre?.trim();
    if (!finalNombre) {
      finalNombre = await this.generateSequentialName(data.departamentoId);
    }

    const existente = await prisma.terminal.findUnique({
      where: { nombre: finalNombre },
    });
    if (existente) {
      throw new ConflictError("Ya existe una terminal con ese nombre administrativo");
    }

    const todosDeptosIds = Array.from(
      new Set([data.departamentoId, ...(data.departamentosIds || [])])
    );

    const deptosDb = await prisma.departamento.findMany({
      where: { id: { in: todosDeptosIds }, estado: "ACTIVO" },
    });
    if (deptosDb.length !== todosDeptosIds.length) {
      throw new BadRequestError(
        "Uno o más departamentos seleccionados no existen o se encuentran inactivos"
      );
    }

    const credencialPlana = this.generateCredential();
    const credencialHash = this.hashCredential(credencialPlana);

    // Transacción atómica: Creación de terminal, asociaciones M:N y registro de auditoría encadenada
    return await prisma.$transaction(async (tx) => {
      const terminal = await tx.terminal.create({
        data: {
          nombre: finalNombre,
          departamentoId: data.departamentoId,
          credencialHash,
          estado: "ACTIVO",
          departamentos: {
            create: todosDeptosIds.map((deptoId) => ({
              departamentoId: deptoId,
              esPrincipal: deptoId === data.departamentoId,
              activo: true,
              creadoPor: data.usuarioAuditId ?? null,
              actualizadoPor: data.usuarioAuditId ?? null,
            })),
          },
        },
        include: {
          departamento: true,
          departamentos: {
            where: { activo: true },
            include: { departamento: true },
            orderBy: [{ esPrincipal: "desc" }, { departamentoId: "asc" }],
          },
        },
      });

      const departamentosActivos = this.extractDepartamentosActivos(terminal);
      const lugarDeteccion = resolverLugarDeteccionTerminal({
        terminalNombre: terminal.nombre,
        departamentoPrincipalNombre: terminal.departamento.nombre,
        departamentosActivos,
      });

      await auditService.registrarEvento(
        {
          accion: "TERMINAL_CREADA",
          modulo: "TERMINALES",
          entidad: "terminal",
          entidadId: String(terminal.id),
          descripcion: `Terminal '${terminal.nombre}' creada y vinculada a [${departamentosActivos.map((d) => d.nombre).join(", ")}]`,
          valoresAnteriores: null,
          valoresPosteriores: {
            nombre: terminal.nombre,
            departamentoId: terminal.departamentoId,
            departamentoNombre: terminal.departamento.nombre,
            departamentosAsociados: departamentosActivos,
            lugarDeteccion,
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
          departamentoId: terminal.departamentoId,
          departamento: terminal.departamento,
          departamentos: departamentosActivos,
          departamentosIds: departamentosActivos.map((d) => d.departamentoId),
          lugarDeteccion,
          estado: terminal.estado,
          fechaCreacion: terminal.fechaCreacion,
        },
        credencial: credencialPlana, // Se entrega una sola vez al vincular
      };
    });
  }

  /**
   * Cambia el nombre visible personalizado de una terminal (ej. a 'SIGMA').
   * No modifica `credencialHash` ni altera snapshots históricos de inspecciones previas.
   */
  async renameTerminal(params: {
    terminalId: number;
    nombre: string;
    motivo?: string;
    usuarioAuditId?: number;
  }) {
    const nuevoNombre = params.nombre.trim();
    if (nuevoNombre.length < 2 || nuevoNombre.length > 60) {
      throw new BadRequestError("El nombre de la terminal debe tener entre 2 y 60 caracteres");
    }

    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: number; nombre: string; departamento_id: number }>>`
        SELECT id, nombre, departamento_id
        FROM terminales
        WHERE id = ${params.terminalId}
        FOR UPDATE
      `;
      if (!locked || locked.length === 0) {
        throw new NotFoundError("Terminal no encontrada");
      }

      const previa = locked[0];
      if (previa.nombre !== nuevoNombre) {
        const duplicada = await tx.terminal.findFirst({
          where: {
            nombre: nuevoNombre,
            id: { not: params.terminalId },
          },
        });
        if (duplicada) {
          throw new ConflictError(`Ya existe otra terminal con el nombre '${nuevoNombre}'`);
        }
      }

      const actualizada = await tx.terminal.update({
        where: { id: params.terminalId },
        data: { nombre: nuevoNombre },
        include: {
          departamento: true,
          departamentos: {
            where: { activo: true },
            include: { departamento: true },
            orderBy: [{ esPrincipal: "desc" }, { departamentoId: "asc" }],
          },
        },
      });

      const departamentosActivos = this.extractDepartamentosActivos(actualizada);
      const lugarDeteccion = resolverLugarDeteccionTerminal({
        terminalNombre: actualizada.nombre,
        departamentoPrincipalNombre: actualizada.departamento.nombre,
        departamentosActivos,
      });

      await auditService.registrarEvento(
        {
          accion: "TERMINAL_RENOMBRADA",
          modulo: "TERMINALES",
          entidad: "terminal",
          entidadId: String(params.terminalId),
          descripcion: `Terminal #${params.terminalId} renombrada de '${previa.nombre}' a '${actualizada.nombre}'`,
          motivo: params.motivo?.trim() || "Actualización de nombre visible de terminal",
          valoresAnteriores: { nombre: previa.nombre },
          valoresPosteriores: {
            nombre: actualizada.nombre,
            lugarDeteccion,
          },
          contexto: {
            usuarioId: params.usuarioAuditId,
            departamentoId: actualizada.departamentoId,
            terminalId: params.terminalId,
          },
        },
        tx
      );

      return {
        ...actualizada,
        departamentosActivos,
        departamentosIds: departamentosActivos.map((d) => d.departamentoId),
        lugarDeteccion,
      };
    });
  }

  /**
   * Actualiza de forma atómica los departamentos asociados a una terminal y su departamento principal.
   * Garantiza estrictamente:
   * - Exactamente 1 departamento principal activo (`PrincipalActivoCount = 1`).
   * - Sincronización inmediata del campo espejo `Terminal.departamentoId = departamentoPrincipalId`.
   * - Eventos de auditoría encadenados en la misma transacción.
   */
  async updateTerminalDepartamentos(params: {
    terminalId: number;
    departamentosIds: number[];
    departamentoPrincipalId: number;
    motivo?: string;
    usuarioAuditId?: number;
  }) {
    const idsUnicos = Array.from(new Set(params.departamentosIds.map(Number)));
    const principalId = Number(params.departamentoPrincipalId);

    if (idsUnicos.length === 0) {
      throw new BadRequestError("La terminal debe tener al menos un departamento activo asociado");
    }

    if (!idsUnicos.includes(principalId)) {
      throw new BadRequestError(
        "El departamento designado como principal debe formar parte de los departamentos activos asociados a la terminal"
      );
    }

    const deptosValidos = await prisma.departamento.findMany({
      where: {
        id: { in: idsUnicos },
        estado: "ACTIVO",
      },
    });

    if (deptosValidos.length !== idsUnicos.length) {
      throw new BadRequestError(
        "Uno o más departamentos seleccionados no existen o se encuentran inactivos"
      );
    }

    return await prisma.$transaction(async (tx) => {
      // 1. Bloqueo pesimista sobre la fila padre de la terminal
      const locked = await tx.$queryRaw<
        Array<{ id: number; nombre: string; departamento_id: number }>
      >`
        SELECT id, nombre, departamento_id
        FROM terminales
        WHERE id = ${params.terminalId}
        FOR UPDATE
      `;
      if (!locked || locked.length === 0) {
        throw new NotFoundError("Terminal no encontrada");
      }

      const terminalPrevia = locked[0];
      const asociacionesPrevias = await tx.terminalDepartamento.findMany({
        where: { terminalId: params.terminalId },
        include: { departamento: { select: { id: true, codigo: true, nombre: true } } },
      });

      const previosActivosIds = new Set(
        asociacionesPrevias.filter((a) => a.activo).map((a) => a.departamentoId)
      );
      const nuevosActivosSet = new Set(idsUnicos);

      // 2. Desmarcar primero cualquier principal previo para respetar el índice único funcional en MySQL
      await tx.terminalDepartamento.updateMany({
        where: {
          terminalId: params.terminalId,
          esPrincipal: true,
        },
        data: {
          esPrincipal: false,
          actualizadoPor: params.usuarioAuditId ?? null,
        },
      });

      // 3. Desactivar departamentos que ya no estén en la lista
      await tx.terminalDepartamento.updateMany({
        where: {
          terminalId: params.terminalId,
          departamentoId: { notIn: idsUnicos },
          activo: true,
        },
        data: {
          activo: false,
          esPrincipal: false,
          actualizadoPor: params.usuarioAuditId ?? null,
        },
      });

      // 4. Upsert de cada departamento activo (marcando esPrincipal solo en principalId)
      for (const deptoId of idsUnicos) {
        const esPrincipal = deptoId === principalId;
        await tx.terminalDepartamento.upsert({
          where: {
            unique_terminal_departamento: {
              terminalId: params.terminalId,
              departamentoId: deptoId,
            },
          },
          create: {
            terminalId: params.terminalId,
            departamentoId: deptoId,
            esPrincipal,
            activo: true,
            creadoPor: params.usuarioAuditId ?? null,
            actualizadoPor: params.usuarioAuditId ?? null,
          },
          update: {
            esPrincipal,
            activo: true,
            actualizadoPor: params.usuarioAuditId ?? null,
          },
        });
      }

      // 5. Sincronizar campo espejo obligatorio Terminal.departamentoId
      const terminalActualizada = await tx.terminal.update({
        where: { id: params.terminalId },
        data: {
          departamentoId: principalId,
        },
        include: {
          departamento: true,
          departamentos: {
            where: { activo: true },
            include: { departamento: true },
            orderBy: [{ esPrincipal: "desc" }, { departamentoId: "asc" }],
          },
        },
      });

      // 6. Post-condición estricta de integridad: exactamente 1 principal activo y coincidente con Terminal.departamentoId
      const principalesActivos = await tx.terminalDepartamento.findMany({
        where: {
          terminalId: params.terminalId,
          esPrincipal: true,
          activo: true,
        },
      });
      if (
        principalesActivos.length !== 1 ||
        principalesActivos[0].departamentoId !== principalId ||
        terminalActualizada.departamentoId !== principalId
      ) {
        throw new BadRequestError(
          "Violación de integridad: la terminal debe conservar exactamente un departamento principal activo sincronizado"
        );
      }

      const departamentosActivos = this.extractDepartamentosActivos(terminalActualizada);
      const lugarDeteccion = resolverLugarDeteccionTerminal({
        terminalNombre: terminalActualizada.nombre,
        departamentoPrincipalNombre: terminalActualizada.departamento.nombre,
        departamentosActivos,
      });

      const agregados = idsUnicos.filter((id) => !previosActivosIds.has(id));
      const desasociados = Array.from(previosActivosIds).filter(
        (id) => !nuevosActivosSet.has(id)
      );
      const cambioPrincipal = terminalPrevia.departamento_id !== principalId;

      const motivoAudit =
        params.motivo?.trim() || "Actualización de configuración multidepartamental de terminal";

      for (const deptoId of agregados) {
        await auditService.registrarEvento(
          {
            accion: "TERMINAL_DEPARTAMENTO_ASOCIADO",
            modulo: "TERMINALES",
            entidad: "terminal",
            entidadId: String(params.terminalId),
            descripcion: `Departamento #${deptoId} asociado a la terminal '${terminalActualizada.nombre}'`,
            motivo: motivoAudit,
            valoresAnteriores: { departamentosActivosIds: Array.from(previosActivosIds) },
            valoresPosteriores: {
              terminalId: params.terminalId,
              departamentoId: deptoId,
              esPrincipal: deptoId === principalId,
              departamentosActivosIds: idsUnicos,
              lugarDeteccion,
            },
            contexto: {
              usuarioId: params.usuarioAuditId,
              departamentoId: principalId,
              terminalId: params.terminalId,
            },
          },
          tx
        );
      }

      for (const deptoId of desasociados) {
        await auditService.registrarEvento(
          {
            accion: "TERMINAL_DEPARTAMENTO_DESASOCIADO",
            modulo: "TERMINALES",
            entidad: "terminal",
            entidadId: String(params.terminalId),
            descripcion: `Departamento #${deptoId} desasociado de la terminal '${terminalActualizada.nombre}'`,
            motivo: motivoAudit,
            valoresAnteriores: {
              terminalId: params.terminalId,
              departamentoId: deptoId,
              departamentosActivosIds: Array.from(previosActivosIds),
            },
            valoresPosteriores: {
              departamentosActivosIds: idsUnicos,
              lugarDeteccion,
            },
            contexto: {
              usuarioId: params.usuarioAuditId,
              departamentoId: principalId,
              terminalId: params.terminalId,
            },
          },
          tx
        );
      }

      if (cambioPrincipal) {
        await auditService.registrarEvento(
          {
            accion: "TERMINAL_PRINCIPAL_CAMBIADO",
            modulo: "TERMINALES",
            entidad: "terminal",
            entidadId: String(params.terminalId),
            descripcion: `Departamento principal de terminal '${terminalActualizada.nombre}' cambiado de #${terminalPrevia.departamento_id} a #${principalId}`,
            motivo: motivoAudit,
            valoresAnteriores: { departamentoPrincipalId: terminalPrevia.departamento_id },
            valoresPosteriores: {
              departamentoPrincipalId: principalId,
              lugarDeteccion,
            },
            contexto: {
              usuarioId: params.usuarioAuditId,
              departamentoId: principalId,
              terminalId: params.terminalId,
            },
          },
          tx
        );
      }

      return {
        ...terminalActualizada,
        departamentosActivos,
        departamentosIds: departamentosActivos.map((d) => d.departamentoId),
        lugarDeteccion,
      };
    });
  }

  /**
   * Valida la credencial de terminal enviada por el navegador en la cabecera HTTP.
   * La terminal debe estar ACTIVA y tener al menos un departamento asociado ACTIVO
   * (incluyendo su departamento principal activo).
   */
  async validateTerminal(credencial: string) {
    if (!credencial) {
      throw new UnauthorizedError("Credencial de terminal no proporcionada");
    }

    const hash = this.hashCredential(credencial);
    const terminal = await prisma.terminal.findUnique({
      where: { credencialHash: hash },
      include: {
        departamento: true,
        departamentos: {
          where: { activo: true },
          include: { departamento: true },
          orderBy: [{ esPrincipal: "desc" }, { departamentoId: "asc" }],
        },
      },
    });

    if (!terminal || terminal.estado !== "ACTIVO" || terminal.fechaRevocacion) {
      throw new UnauthorizedError("Terminal inválida, bloqueada o revocada");
    }

    const departamentosActivos = this.extractDepartamentosActivos(terminal);

    if (terminal.departamento.estado !== "ACTIVO" || departamentosActivos.length === 0) {
      throw new UnauthorizedError("El departamento de la terminal se encuentra inactivo");
    }

    const lugarDeteccion = resolverLugarDeteccionTerminal({
      terminalNombre: terminal.nombre,
      departamentoPrincipalNombre: terminal.departamento.nombre,
      departamentosActivos,
    });

    // Actualizar fecha de último acceso
    await prisma.terminal.update({
      where: { id: terminal.id },
      data: { fechaUltimoAcceso: new Date() },
    });

    return {
      ...terminal,
      departamentosActivos,
      departamentosIds: departamentosActivos.map((d) => d.departamentoId),
      lugarDeteccion,
    };
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

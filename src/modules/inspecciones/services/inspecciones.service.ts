import { prisma } from "../../../config/database";
import { NotFoundError, BadRequestError } from "../../../utils/errors";
import { auditService } from "../../audit/services/audit.service";

export interface ItemDefectoInput {
  defectoId: number;
  defDeptoId?: number;
  paresDefectuosos: number;
  notas?: string;
}

export interface CreateInspeccionParams {
  lote: string;
  lineaId?: number | null;
  lineaTexto?: string | null;
  horma?: string | null;
  notas?: string | null;
  detalles: ItemDefectoInput[];
  usuarioId: number;
  /** Clave opcional de idempotencia (por inspector) para evitar duplicados por doble envío o reintentos. */
  claveIdempotencia?: string | null;
  terminal?: {
    id: number;
    nombre: string;
    departamentoId: number;
  };
  reqInfo?: {
    ip?: string;
    userAgent?: string;
    method?: string;
    url?: string;
  };
}

export interface GetInspeccionesParams {
  periodo?: "hoy" | "ultimos" | "todos";
  busqueda?: string;
  lote?: string;
  defectoClave?: number;
  departamentoId?: number;
  departamentoAuditoriaId?: number;
  departamentoResponsableId?: number;
  clasificacion?: "CRITICO" | "MAYOR" | "MENOR";
  lineaId?: number;
  lineaTexto?: string;
  inspectorId?: number;
  mes?: number;
  anio?: number;
  /** Rango de fechas de inspección (inclusive). */
  fechaDesde?: Date;
  fechaHasta?: Date;
  terminalId?: number;
  soloEliminados?: boolean;
  page: number;
  limit: number;
}

export interface EliminacionLogicaParams {
  usuarioId: number;
  motivo?: string;
  reqInfo?: { ip?: string; userAgent?: string; method?: string; url?: string };
}

export class InspeccionesService {
  async cancelarDetalleInspeccion(detalleId: number, params: EliminacionLogicaParams) {
    const detalle = await prisma.inspeccionDetalle.findUnique({
      where: { id: detalleId },
      include: {
        inspeccion: { include: { departamentoAuditoria: true, lote: true } },
        defecto: true,
      },
    });

    if (!detalle || detalle.eliminadoEn) {
      throw new NotFoundError("El registro de defecto no existe o ya fue eliminado");
    }

    // Regla de negocio: Solo se pueden eliminar defectos de los últimos 30 días
    const fechaInspeccion = new Date(detalle.inspeccion.fechaInspeccion);
    const limite30Dias = new Date();
    limite30Dias.setDate(limite30Dias.getDate() - 30);
    // Establecer al inicio del día límite (00:00:00) para permitir todo el día 30
    limite30Dias.setHours(0, 0, 0, 0);

    if (fechaInspeccion < limite30Dias) {
      throw new BadRequestError(
        "No es posible eliminar este registro: solo se permite eliminar defectos registrados dentro de los últimos 30 días"
      );
    }

    return prisma.$transaction(async (tx) => {
      // Actualización condicionada: evita doble eliminación concurrente
      const afectados = await tx.inspeccionDetalle.updateMany({
        where: { id: detalleId, eliminadoEn: null },
        data: {
          eliminadoEn: new Date(),
          eliminadoPor: params.usuarioId,
          eliminadoMotivo: params.motivo || "Eliminación de defecto en estación",
        },
      });
      if (afectados.count !== 1) {
        throw new NotFoundError("El registro de defecto no existe o ya fue eliminado");
      }
      const cancelado = await tx.inspeccionDetalle.findUniqueOrThrow({ where: { id: detalleId } });

      // Limpiar estructura para serialización JSON segura en auditoría
      const { inspeccion, defecto, ...detalleLimpio } = detalle;

      await auditService.registrarEvento({
        accion: "DEFECTO_INSPECCION_ELIMINADO",
        modulo: "INSPECCIONES",
        entidad: "InspeccionDetalle",
        entidadId: detalleId.toString(),
        descripcion: `Eliminación de defecto #${defecto.clave} en lote ${inspeccion.lote.lote} por usuario ID ${params.usuarioId}`,
        motivo: params.motivo || "Eliminación de defecto en estación",
        valoresAnteriores: {
          ...detalleLimpio,
          defectoClave: defecto.clave,
          defectoNombre: defecto.defecto,
          lote: inspeccion.lote.lote,
        } as any,
        valoresPosteriores: cancelado as any,
        contexto: {
          usuarioId: params.usuarioId,
          departamentoId: inspeccion.departamentoAuditoriaId,
          terminalId: inspeccion.terminalId ?? undefined,
          ipOrigen: params.reqInfo?.ip,
          agenteUsuario: params.reqInfo?.userAgent,
          metodoHttp: params.reqInfo?.method,
          rutaHttp: params.reqInfo?.url,
        } as any,
      }, tx);

      return cancelado;
    });
  }

  /**
   * Recupera (revierte el borrado lógico de) un defecto registrado. No hay borrado físico.
   */
  async recuperarDetalleInspeccion(detalleId: number, params: EliminacionLogicaParams) {
    const detalle = await prisma.inspeccionDetalle.findUnique({
      where: { id: detalleId },
      include: {
        inspeccion: { include: { lote: true } },
        defecto: true,
      },
    });

    if (!detalle || !detalle.eliminadoEn) {
      throw new NotFoundError("El registro de defecto no existe o no está eliminado");
    }
    if (detalle.inspeccion.eliminadoEn) {
      throw new BadRequestError("No es posible recuperar el defecto: la inspección asociada está eliminada");
    }

    return prisma.$transaction(async (tx) => {
      const afectados = await tx.inspeccionDetalle.updateMany({
        where: { id: detalleId, eliminadoEn: { not: null } },
        data: {
          eliminadoEn: null,
          eliminadoPor: null,
          eliminadoMotivo: null,
          actualizadoPor: params.usuarioId,
        },
      });
      if (afectados.count !== 1) {
        throw new NotFoundError("El registro de defecto no existe o no está eliminado");
      }
      const recuperado = await tx.inspeccionDetalle.findUniqueOrThrow({ where: { id: detalleId } });

      await auditService.registrarEvento({
        accion: "DEFECTO_INSPECCION_RECUPERADO",
        modulo: "INSPECCIONES",
        entidad: "InspeccionDetalle",
        entidadId: detalleId.toString(),
        descripcion: `Recuperación de defecto #${detalle.defecto.clave} en lote ${detalle.inspeccion.lote.lote} por usuario ID ${params.usuarioId}`,
        motivo: params.motivo || "Recuperación de defecto en estación",
        valoresAnteriores: {
          eliminadoEn: detalle.eliminadoEn,
          eliminadoPor: detalle.eliminadoPor,
          eliminadoMotivo: detalle.eliminadoMotivo,
        },
        valoresPosteriores: { eliminadoEn: null, eliminadoPor: null, eliminadoMotivo: null },
        contexto: {
          usuarioId: params.usuarioId,
          departamentoId: detalle.inspeccion.departamentoAuditoriaId,
          terminalId: detalle.inspeccion.terminalId ?? undefined,
          ipOrigen: params.reqInfo?.ip,
          agenteUsuario: params.reqInfo?.userAgent,
          metodoHttp: params.reqInfo?.method,
          rutaHttp: params.reqInfo?.url,
        } as any,
      }, tx);

      return recuperado;
    });
  }

  /**
   * Detalle completo de una inspección: cabecera, lote, terminal, usuario y defectos.
   * - `soloPropiaDeUsuarioId`: si se indica, solo devuelve la inspección si pertenece a ese inspector.
   * - `incluirEliminados`: incluye defectos con borrado lógico (requiere permiso en la capa de ruta).
   * - `incluirTrazabilidad`: incluye eventos de auditoría de la inspección y sus defectos.
   */
  async getDetalleInspeccion(
    id: number,
    opts: { soloPropiaDeUsuarioId?: number; incluirEliminados: boolean; incluirTrazabilidad: boolean }
  ) {
    const inspeccion = await prisma.inspeccionCabecera.findFirst({
      where: {
        id,
        eliminadoEn: null,
        ...(opts.soloPropiaDeUsuarioId ? { inspectorId: opts.soloPropiaDeUsuarioId } : {}),
      },
      include: {
        lote: true,
        inspector: { select: { id: true, usuario: true, nombre: true } },
        departamentoAuditoria: { select: { id: true, codigo: true, nombre: true } },
        terminal: { select: { id: true, nombre: true } },
        linea: { select: { id: true, codigo: true, nombre: true } },
        detalles: {
          where: opts.incluirEliminados ? {} : { eliminadoEn: null },
          orderBy: { id: "asc" },
          include: {
            defecto: { select: { id: true, clave: true, defecto: true, clasificacion: true } },
            departamentoResponsable: { select: { id: true, codigo: true, nombre: true } },
          },
        },
      },
    });

    if (!inspeccion) {
      throw new NotFoundError("La inspección no existe o no está disponible para su consulta");
    }

    let trazabilidad: unknown[] | undefined;
    if (opts.incluirTrazabilidad) {
      const detalleIds = inspeccion.detalles.map((d) => String(d.id));
      const eventos = await prisma.registroAuditoria.findMany({
        where: {
          OR: [
            { entidad: "inspeccion_cabecera", entidadId: String(inspeccion.id) },
            ...(detalleIds.length > 0 ? [{ entidad: "InspeccionDetalle", entidadId: { in: detalleIds } }] : []),
          ],
        },
        select: {
          id: true,
          fecha: true,
          accion: true,
          entidad: true,
          entidadId: true,
          detalles: true,
          motivo: true,
          usuario: { select: { id: true, usuario: true, nombre: true } },
          terminal: { select: { id: true, nombre: true } },
        },
        orderBy: { id: "asc" },
      });
      trazabilidad = eventos;
    }

    return {
      ...inspeccion,
      // Las filas de estas tablas solo se crean desde POST /inspecciones (captura web).
      // Los registros históricos TXT residen en inspecciones_historicas_origen, no en este modelo.
      origen: "WEB" as const,
      ...(trazabilidad ? { trazabilidad } : {}),
    };
  }

  /**
   * Genera un folio correlativo único para la inspección.
   */
  private async generateNextFolio(tx: any): Promise<string> {
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(today.getUTCDate()).padStart(2, "0");
    const prefix = `INS-${yyyy}${mm}${dd}-`;

    const last = await tx.inspeccionCabecera.findFirst({
      where: {
        folio: { startsWith: prefix },
      },
      orderBy: { id: "desc" },
      select: { folio: true },
    });

    let nextNumber = 1;
    if (last && last.folio) {
      const parts = last.folio.split("-");
      const num = parseInt(parts[2], 10);
      if (!isNaN(num)) {
        nextNumber = num + 1;
      }
    }

    return `${prefix}${String(nextNumber).padStart(4, "0")}`;
  }

  /**
   * Registra una inspección de forma estrictamente atómica en MySQL ($transaction).
   * Mantiene el contrato histórico: devuelve la inspección completa.
   */
  async createInspeccion(params: CreateInspeccionParams) {
    const { inspeccion } = await this.registrarInspeccion(params);
    return inspeccion;
  }

  private async buscarPorClaveIdempotencia(inspectorId: number, clave: string) {
    return prisma.inspeccionCabecera.findUnique({
      where: { unique_inspector_clave_idempotencia: { inspectorId, claveIdempotencia: clave } },
      include: this.includeInspeccionCompleta,
    });
  }

  private readonly includeInspeccionCompleta = {
    lote: true,
    inspector: { select: { id: true, usuario: true, nombre: true } },
    departamentoAuditoria: { select: { id: true, codigo: true, nombre: true } },
    terminal: { select: { id: true, nombre: true } },
    linea: { select: { id: true, codigo: true, nombre: true } },
    detalles: {
      include: {
        defecto: { select: { id: true, clave: true, defecto: true, clasificacion: true } },
        departamentoResponsable: { select: { id: true, codigo: true, nombre: true } },
      },
    },
  } as const;

  /**
   * Igual que createInspeccion, pero indica si la respuesta corresponde a un reintento idempotente.
   */
  async registrarInspeccion(params: CreateInspeccionParams) {
    const {
      lote: codigoLote,
      lineaId,
      lineaTexto,
      horma: hormaParam,
      notas,
      detalles,
      usuarioId,
      terminal,
      reqInfo,
      claveIdempotencia,
    } = params;

    // Idempotencia: si la misma clave ya produjo una inspección de este inspector, se devuelve esa misma (sin duplicar).
    if (claveIdempotencia) {
      const previa = await this.buscarPorClaveIdempotencia(usuarioId, claveIdempotencia);
      if (previa) return { inspeccion: previa, repetida: true };
    }

    const loteExistente = await prisma.produccionLote.findFirst({
      where: {
        lote: codigoLote.trim(),
        eliminadoEn: null,
      },
    });

    if (!loteExistente) {
      throw new NotFoundError(`El lote '${codigoLote}' no existe en el sistema de producción.`);
    }

    if (loteExistente.estado !== "ACTIVO") {
      throw new BadRequestError(`El lote '${codigoLote}' no está activo en el sistema de producción.`);
    }

    // Un mismo defecto no puede repetirse en una captura (la interfaz acumula pares del mismo defecto)
    const idsRepetidos = detalles
      .map((d) => d.defectoId)
      .filter((id, idx, arr) => arr.indexOf(id) !== idx);
    if (idsRepetidos.length > 0) {
      throw new BadRequestError(
        `Defectos duplicados en la captura: IDs [${Array.from(new Set(idsRepetidos)).join(", ")}]. Acumule los pares en una sola línea.`
      );
    }

    // Los pares defectuosos de un defecto no pueden exceder la cantidad del lote (misma regla que la interfaz)
    const maxPares = Math.max(1, Math.floor(Number(loteExistente.cantidad)));
    const excedido = detalles.find((d) => d.paresDefectuosos > maxPares);
    if (excedido) {
      throw new BadRequestError(
        `Los pares defectuosos (${excedido.paresDefectuosos}) exceden la cantidad del lote (${maxPares}).`
      );
    }

    // 1. El departamento auditor se obtiene EXCLUSIVAMENTE de la terminal física validada por el servidor
    if (!terminal || !terminal.departamentoId) {
      throw new BadRequestError(
        "No es posible capturar inspecciones: se requiere una estación de trabajo física vinculada y activa."
      );
    }
    const deptoAuditoriaId = terminal.departamentoId;

    if (lineaId) {
      const linea = await prisma.linea.findUnique({
        where: { id: lineaId },
        select: { id: true, estado: true },
      });
      if (!linea || linea.estado !== "ACTIVO") {
        throw new BadRequestError("La línea de producción especificada no es válida o está inactiva.");
      }

      // Validar que el departamento auditor pertenezca a la línea especificada
      const deptoEnLinea = await prisma.departamentoLinea.findFirst({
        where: {
          lineaId,
          departamentoId: deptoAuditoriaId,
          activo: true,
          eliminadoEn: null,
        },
      });
      if (!deptoEnLinea) {
        throw new BadRequestError(
          "El departamento auditor no está asignado o no está activo en la línea de producción especificada."
        );
      }
    }

    const defectosIds = Array.from(new Set(detalles.map((d) => d.defectoId)));
    const defectosEncontrados = await prisma.defecto.findMany({
      where: {
        id: { in: defectosIds },
        activo: true,
        eliminadoEn: null,
      },
      select: {
        id: true,
        clave: true,
        defecto: true,
        clasificacion: true,
        departamentoId: true,
        departamento: {
          select: { id: true, codigo: true, nombre: true },
        },
        etapas: {
          where: { departamentoId: deptoAuditoriaId },
          select: { permitido: true },
        },
      },
    });

    if (defectosEncontrados.length !== defectosIds.length) {
      const encontradosSet = new Set(defectosEncontrados.map((d) => d.id));
      const faltantes = defectosIds.filter((id) => !encontradosSet.has(id));
      throw new BadRequestError(
        `Uno o más defectos seleccionados no existen o están inactivos: IDs [${faltantes.join(", ")}]`
      );
    }

    // Validar matriz de etapas de detección: verificar si cada defecto está permitido en deptoAuditoriaId
    const deptoAuditoria = await prisma.departamento.findUnique({
      where: { id: deptoAuditoriaId },
      select: { id: true, codigo: true, nombre: true },
    });

    const defectosMap = new Map(defectosEncontrados.map((d) => [d.id, d]));
    for (const defId of defectosIds) {
      const def = defectosMap.get(defId)!;
      // Whitelist estricta: debe existir relación explícita en la matriz y tener permitido = true
      const etapaPermiso = def.etapas[0];
      if (!etapaPermiso || !etapaPermiso.permitido) {
        throw new BadRequestError(
          `El defecto ${def.clave} ('${def.defecto}') no está permitido para inspección en la etapa de ${deptoAuditoria?.nombre || "este departamento"}.`
        );
      }
    }

    // Resolver departamento responsable (propietario): siempre se asigna desde el catálogo oficial
    const detallesPreparados = detalles.map((item) => {
      const def = defectosMap.get(item.defectoId)!;
      const defDeptoId = def.departamentoId;
      return {
        ...item,
        defDeptoId,
      };
    });

    const deptosResponsablesIds = Array.from(new Set(detallesPreparados.map((d) => d.defDeptoId)));
    const deptosEncontrados = await prisma.departamento.findMany({
      where: {
        id: { in: deptosResponsablesIds },
        estado: "ACTIVO",
      },
      select: { id: true, nombre: true },
    });

    if (deptosEncontrados.length !== deptosResponsablesIds.length) {
      const encontradosSet = new Set(deptosEncontrados.map((d) => d.id));
      const faltantes = deptosResponsablesIds.filter((id) => !encontradosSet.has(id));
      throw new BadRequestError(
        `Uno o más departamentos responsables no existen o están inactivos: IDs [${faltantes.join(", ")}]`
      );
    }

    const hormaEfectiva = hormaParam || loteExistente.horma || null;

    const ejecutarTransaccion = () =>
      prisma.$transaction(async (tx) => {
      const folio = await this.generateNextFolio(tx);

      const cabecera = await tx.inspeccionCabecera.create({
        data: {
          folio,
          loteId: loteExistente.id,
          inspectorId: usuarioId,
          departamentoAuditoriaId: deptoAuditoriaId,
          terminalId: terminal?.id || null,
          lineaId: lineaId || null,
          lineaTexto: lineaTexto || (lineaId ? null : "L1"),
          horma: hormaEfectiva,
          claveIdempotencia: claveIdempotencia || null,
          estado: "RECHAZADO",
          notas: notas || null,
          creadoPor: usuarioId,
        },
      });

      await tx.inspeccionDetalle.createMany({
        data: detallesPreparados.map((item) => ({
          inspeccionId: cabecera.id,
          defectoId: item.defectoId,
          defDeptoId: item.defDeptoId,
          paresDefectuosos: item.paresDefectuosos,
          notas: item.notas || null,
          creadoPor: usuarioId,
        })),
      });

      const inspeccionCompleta = await tx.inspeccionCabecera.findUniqueOrThrow({
        where: { id: cabecera.id },
        include: {
          lote: true,
          inspector: {
            select: { id: true, usuario: true, nombre: true },
          },
          departamentoAuditoria: {
            select: { id: true, codigo: true, nombre: true },
          },
          terminal: {
            select: { id: true, nombre: true },
          },
          linea: {
            select: { id: true, codigo: true, nombre: true },
          },
          detalles: {
            include: {
              defecto: {
                select: { id: true, clave: true, defecto: true, clasificacion: true },
              },
              departamentoResponsable: {
                select: { id: true, codigo: true, nombre: true },
              },
            },
          },
        },
      });

      await auditService.registrarEvento(
        {
          accion: "INSPECCION_REGISTRADA",
          modulo: "CALIDAD_OPERATIVA",
          entidad: "inspeccion_cabecera",
          entidadId: String(cabecera.id),
          descripcion: `Inspección ${folio} capturada para lote ${loteExistente.lote} con ${detalles.length} defectos registrados.`,
          valoresAnteriores: null,
          valoresPosteriores: {
            folio: cabecera.folio,
            loteId: loteExistente.id,
            loteCodigo: loteExistente.lote,
            modelo: loteExistente.modelo,
            cantidadLote: Number(loteExistente.cantidad),
            departamentoAuditoriaId: deptoAuditoriaId,
            terminalId: terminal?.id || null,
            totalDefectos: detalles.length,
            totalParesDefectuosos: detalles.reduce((acc, d) => acc + d.paresDefectuosos, 0),
          },
          contexto: {
            usuarioId,
            departamentoId: deptoAuditoriaId,
            terminalId: terminal?.id,
            ipOrigen: reqInfo?.ip,
            agenteUsuario: reqInfo?.userAgent,
            metodoHttp: reqInfo?.method,
            rutaHttp: reqInfo?.url,
          },
        },
        tx
      );

      return inspeccionCompleta;
      });

    // Reintenta ante colisión del folio correlativo (capturas simultáneas) o carrera de idempotencia.
    const MAX_INTENTOS = 5;
    for (let intento = 1; ; intento++) {
      try {
        const inspeccion = await ejecutarTransaccion();
        return { inspeccion, repetida: false };
      } catch (error: any) {
        if (error?.code !== "P2002") throw error;
        if (claveIdempotencia) {
          const previa = await this.buscarPorClaveIdempotencia(usuarioId, claveIdempotencia);
          if (previa) return { inspeccion: previa, repetida: true };
        }
        if (intento >= MAX_INTENTOS) {
          throw new BadRequestError("No fue posible asignar un folio único a la inspección. Intente nuevamente.");
        }
      }
    }
  }

  /**
   * Consulta a nivel de cada defecto registrado (fila unitaria como en el sistema original).
   * Soporta periodos: 'hoy', 'ultimos' (30 registros) y 'todos' (con filtro por mes y año).
   * Búsqueda por Lote o Clave de Defecto.
   */
  async getFilasInspeccion(params: GetInspeccionesParams) {
    const where: Record<string, unknown> = {
      eliminadoEn: params.soloEliminados ? { not: null } : null,
      inspeccion: {
        eliminadoEn: null,
      },
    };

    const andConditions: any[] = [];

    // 1. Filtro por departamento auditor, responsable o unificado
    if (params.departamentoId) {
      andConditions.push({
        OR: [
          { inspeccion: { departamentoAuditoriaId: params.departamentoId } },
          { defDeptoId: params.departamentoId },
        ],
      });
    } else {
      if (params.departamentoAuditoriaId) {
        (where.inspeccion as any).departamentoAuditoriaId = params.departamentoAuditoriaId;
      }

      if (params.departamentoResponsableId) {
        where.defDeptoId = params.departamentoResponsableId;
      }
    }

    if (params.clasificacion) {
      where.defecto = { ...(where.defecto as any || {}), clasificacion: params.clasificacion };
    }

    if (params.lineaId) {
      (where.inspeccion as any).lineaId = params.lineaId;
    }

    if (params.lineaTexto) {
      (where.inspeccion as any).lineaTexto = params.lineaTexto;
    }

    if (params.inspectorId) {
      (where.inspeccion as any).inspectorId = params.inspectorId;
    }

    if (params.terminalId) {
      (where.inspeccion as any).terminalId = params.terminalId;
    }

    // Rango explícito de fechas: tiene precedencia sobre el período/mes/año
    const rangoExplicito = Boolean(params.fechaDesde || params.fechaHasta);
    if (rangoExplicito) {
      (where.inspeccion as any).fechaInspeccion = {
        ...(params.fechaDesde ? { gte: params.fechaDesde } : {}),
        ...(params.fechaHasta ? { lte: params.fechaHasta } : {}),
      };
    }

    const periodo = rangoExplicito ? "todos" : params.periodo || "ultimos";

    // 2. Filtro temporal según período (Si es soloEliminados, no aplicamos filtro temporal estricto a menos que se solicite)
    if (!params.soloEliminados && !rangoExplicito) {
      if (periodo === "hoy") {
        const hoyInicio = new Date();
        hoyInicio.setHours(0, 0, 0, 0);
        const hoyFin = new Date();
        hoyFin.setHours(23, 59, 59, 999);

        (where.inspeccion as any).fechaInspeccion = {
          gte: hoyInicio,
          lte: hoyFin,
        };
      } else if (periodo === "todos" && (params.mes || params.anio)) {
        const anioActual = params.anio || new Date().getFullYear();
        let fechaInicio: Date;
        let fechaFin: Date;

        if (params.mes) {
          fechaInicio = new Date(anioActual, params.mes - 1, 1, 0, 0, 0, 0);
          fechaFin = new Date(anioActual, params.mes, 0, 23, 59, 59, 999);
        } else {
          fechaInicio = new Date(anioActual, 0, 1, 0, 0, 0, 0);
          fechaFin = new Date(anioActual, 11, 31, 23, 59, 59, 999);
        }

        (where.inspeccion as any).fechaInspeccion = {
          gte: fechaInicio,
          lte: fechaFin,
        };
      }
    }

    // 3. Búsqueda por Lote o Clave de Defecto
    if (params.busqueda) {
      const q = params.busqueda.trim();
      const qNum = parseInt(q, 10);
      const orConditions: any[] = [
        {
          inspeccion: {
            lote: {
              OR: [
                { lote: { contains: q } },
                { modelo: { contains: q } },
                { lista: { contains: q } },
                { cliente: { contains: q } },
              ],
            },
          },
        },
        {
          defecto: {
            defecto: { contains: q },
          },
        },
      ];

      if (!isNaN(qNum)) {
        orConditions.push({
          defecto: {
            clave: qNum,
          },
        });
      }

      andConditions.push({ OR: orConditions });
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    if (params.lote) {
      (where.inspeccion as any).lote = {
        lote: { contains: params.lote.trim() },
      };
    }

    if (params.defectoClave) {
      where.defecto = { ...(where.defecto as any || {}), clave: params.defectoClave };
    }

    // Límite según periodo: Si es 'ultimos' (y no soloEliminados), son estrictamente los últimos 30 registros fijos
    const take = (!params.soloEliminados && periodo === "ultimos") ? 30 : params.limit;
    const skip = (!params.soloEliminados && periodo === "ultimos") ? 0 : (params.page - 1) * take;

    const [detalles, total] = await Promise.all([
      prisma.inspeccionDetalle.findMany({
        where,
        skip,
        take,
        orderBy: { id: "desc" },
        include: {
          inspeccion: {
            include: {
              lote: true,
              inspector: {
                select: { id: true, usuario: true, nombre: true },
              },
              departamentoAuditoria: {
                select: { id: true, codigo: true, nombre: true },
              },
              linea: {
                select: { id: true, codigo: true, nombre: true },
              },
              terminal: {
                select: { id: true, nombre: true },
              },
            },
          },
          defecto: {
            select: { id: true, clave: true, defecto: true, clasificacion: true },
          },
          departamentoResponsable: {
            select: { id: true, codigo: true, nombre: true },
          },
        },
      }),
      prisma.inspeccionDetalle.count({ where }),
    ]);

    // Obtener nombres de usuarios que eliminaron si existen registros eliminados
    const eliminadoresIds = Array.from(
      new Set(
        detalles
          .map((d) => d.eliminadoPor)
          .filter((id): id is number => typeof id === "number" && id > 0)
      )
    );

    const usuariosEliminadores =
      eliminadoresIds.length > 0
        ? await prisma.usuario.findMany({
            where: { id: { in: eliminadoresIds } },
            select: { id: true, usuario: true, nombre: true },
          })
        : [];

    const mapEliminadores = new Map(
      usuariosEliminadores.map((u) => [u.id, u.nombre || u.usuario])
    );

    // Mapear al formato idéntico del sistema de inspectores
    const items = detalles.map((d) => ({
      id: d.id,
      inspeccionId: d.inspeccionId,
      folio: d.inspeccion.folio,
      departamentoAuditoria: d.inspeccion.departamentoAuditoria.nombre,
      departamentoAuditoriaCodigo: d.inspeccion.departamentoAuditoria.codigo,
      fecha: d.inspeccion.fechaInspeccion,
      lista: d.inspeccion.lote.lista,
      lote: d.inspeccion.lote.lote,
      linea: d.inspeccion.lineaTexto || d.inspeccion.linea?.nombre || "L1",
      modelo: d.inspeccion.lote.modelo,
      descripcion: d.inspeccion.lote.descripcion,
      horma: d.inspeccion.horma || d.inspeccion.lote.horma || "N/A",
      cliente: d.inspeccion.lote.cliente,
      cantidadLote: Number(d.inspeccion.lote.cantidad),
      defDepto: d.departamentoResponsable.nombre,
      defectoId: d.defecto.id,
      defectoClave: d.defecto.clave,
      defectoNombre: d.defecto.defecto,
      clasificacion: d.defecto.clasificacion,
      paresDefectuosos: d.paresDefectuosos,
      notas: d.notas,
      usuario: d.inspeccion.inspector.nombre || d.inspeccion.inspector.usuario,
      terminal: d.inspeccion.terminal?.nombre ?? null,
      terminalId: d.inspeccion.terminal?.id ?? null,
      eliminadoEn: d.eliminadoEn,
      eliminadoPor: d.eliminadoPor,
      eliminadoPorNombre: d.eliminadoPor ? mapEliminadores.get(d.eliminadoPor) || `Usuario #${d.eliminadoPor}` : null,
      eliminadoMotivo: d.eliminadoMotivo,
    }));

    const effectiveTotal = periodo === "ultimos" ? Math.min(30, total) : total;

    return {
      items,
      total: effectiveTotal,
      periodo,
      page: periodo === "ultimos" ? 1 : params.page,
      limit: take,
      totalPages: periodo === "ultimos" ? 1 : Math.ceil(total / take) || 1,
    };
  }

  /**
   * Obtiene la lista de inspectores (usuarios que han realizado inspecciones o tienen rol de inspector/administrador)
   */
  async getInspectores() {
    const usuarios = await prisma.usuario.findMany({
      where: {
        estado: "ACTIVO",
        OR: [
          { rol: { codigo: { in: ["INSPECTOR", "SUPER_ADMIN", "ADMIN", "COORD"] } } },
          { inspeccionesInspector: { some: {} } },
        ],
      },
      select: {
        id: true,
        nombre: true,
        usuario: true,
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

    return usuarios;
  }
}

export const inspeccionesService = new InspeccionesService();

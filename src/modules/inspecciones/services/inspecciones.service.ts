import { Prisma } from "@prisma/client";
import { prisma } from "../../../config/database";
import { NotFoundError, BadRequestError, ConflictError, UnauthorizedError, ForbiddenError } from "../../../utils/errors";
import { auditService } from "../../audit/services/audit.service";
import { offlineAuthService } from "../../auth/services/offline-auth.service";
import { permissionsService } from "../../auth/services/permissions.service";
import { inspeccionesLegacyService, type LegacyWriteResult } from "./inspecciones-legacy.service";
import { matrizVisibilidadDefectosService } from "../../defectos/services/matriz-visibilidad.service";
import {
  NOMBRES_MESES_ES,
  formatearDiaDisponible,
  getHoyMexicoStr,
  getIsoYearAndWeek,
  getPartesFechaMexico,
  getRangoAnioIsoCompletoUtc,
  getRangoAnioUtc,
  getRangoDiaUtc,
  getRangoMesUtc,
  getRangoPersonalizadoUtc,
  getRangoSemanaIsoUtc,
} from "../../../utils/timezone";

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
  /** Estado explícito de la cabecera (por defecto RECHAZADO; PENDIENTE si requiere revisión de auditoría). */
  estadoCabecera?: "RECHAZADO" | "PENDIENTE" | "APROBADO";
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

export interface SyncOfflineItemInput {
  idLocalCliente: string;
  inspectorId: number;
  offlineToken: string;
  fechaCapturaDispositivo: string;
  esContingencia?: boolean;
  motivoContingencia?: string | null;
  payload: {
    lote: string;
    lineaId?: number | null;
    lineaTexto?: string | null;
    horma?: string | null;
    notas?: string | null;
    detalles: ItemDefectoInput[];
  };
}

export interface SyncOfflineItemResult {
  idLocalCliente: string;
  inspectorId: number;
  estado: "SINCRONIZADA" | "REPETIDA_IDEMPOTENTE" | "CONFLICTO_IDEMPOTENCIA" | "REQUIERE_REVISION" | "RECHAZADA" | "ERROR_REINTENTABLE";
  folio?: string;
  inspeccionId?: number;
  legacySincronizado: boolean;
  yaEstabaLegacy?: boolean;
  requiereRevision?: boolean;
  motivoRevision?: string;
  mensaje: string;
  codigoHttp: number;
}

export type ModalidadPeriodoInspeccion =
  | "hoy"
  | "ultimos"
  | "todos"
  | "anio"
  | "mes"
  | "semana"
  | "dia"
  | "rango";

export interface FiltrosBaseInspeccionesParams {
  periodo?: ModalidadPeriodoInspeccion;
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
  alcanceRestringido?: {
    usuarioId: number;
    departamentosIds?: number[];
    terminalId?: number;
  };
  /**
   * Departamentos autorizados cuando un usuario con alcance general (ej. COORD/ADMIN)
   * tiene restricción departamental explícita asignada.
   */
  departamentosPermitidosIds?: number[];
  dia?: string;
  semana?: number;
  anioIso?: number;
  mes?: number;
  anio?: number;
  /** Rango de fechas de inspección (`AAAA-MM-DD` en `America/Mexico_City` o `Date`). */
  fechaDesde?: string | Date;
  fechaHasta?: string | Date;
  terminalId?: number;
  soloEliminados?: boolean;
}

export interface GetInspeccionesParams extends FiltrosBaseInspeccionesParams {
  page: number;
  limit: number;
}

export interface GetPeriodosDisponiblesParams extends FiltrosBaseInspeccionesParams {}

export interface GetInspectoresParams {
  departamentoId?: number;
  departamentosPermitidosIds?: number[];
}

export interface EliminacionLogicaParams {
  usuarioId: number;
  motivo?: string;
  reqInfo?: { ip?: string; userAgent?: string; method?: string; url?: string };
}

export class InspeccionesService {
  /**
   * Resumen general del dashboard de inicio para todos los roles (global).
   * Devuelve:
   * 1. contadoresDeptoHoy: pares e incidencias registradas hoy agrupadas por departamento del defecto.
   * 2. topSemanal: top 10 defectos de la semana agrupados por línea operativa.
   */
  async getDashboardMetricas() {
    const hoyStr = getHoyMexicoStr();
    const { inicioUtc: hoyInicio, finUtc: hoyFin } = getRangoDiaUtc(hoyStr);
    const isoHoy = getIsoYearAndWeek(hoyStr);
    const { inicioUtc: lunesSemana } = getRangoSemanaIsoUtc(isoHoy.anioIso, isoHoy.semanaIso);

    const [deptosHoyGroup, detallesSemana] = await Promise.all([
      prisma.inspeccionDetalle.groupBy({
        by: ["defDeptoId"],
        where: {
          eliminadoEn: null,
          inspeccion: {
            eliminadoEn: null,
            fechaInspeccion: { gte: hoyInicio, lt: hoyFin },
          },
        },
        _sum: { paresDefectuosos: true },
        _count: { id: true },
      }),
      prisma.inspeccionDetalle.findMany({
        where: {
          eliminadoEn: null,
          inspeccion: {
            eliminadoEn: null,
            fechaInspeccion: { gte: lunesSemana, lt: hoyFin },
          },
        },
        select: {
          defectoId: true,
          defecto: {
            select: { clave: true, defecto: true },
          },
          departamentoResponsable: {
            select: {
              id: true,
              nombre: true,
              lineasAsociadas: {
                where: { eliminadoEn: null, activo: true },
                select: { linea: { select: { nombre: true } } },
              },
            },
          },
        },
      }),
    ]);

    // 1. Mapa de contadores por departamento (hoy)
    const contadoresDeptoHoy: Record<number, { pares: number; incidencias: number }> = {};
    for (const g of deptosHoyGroup) {
      if (g.defDeptoId) {
        contadoresDeptoHoy[g.defDeptoId] = {
          pares: g._sum.paresDefectuosos || 0,
          incidencias: g._count.id || 0,
        };
      }
    }

    // 2. Agrupación dinámica por línea y top 10 semanal (contando incidencias/defectos)
    const porLinea: Record<string, Map<number, { clave: number; defecto: string; defectos: number }>> = {};

    for (const d of detallesSemana) {
      // Resolver la línea real asociada al departamento del defecto en la base de datos
      const lineaAsociada = d.departamentoResponsable?.lineasAsociadas?.[0]?.linea?.nombre?.trim();
      const lineaNombre = lineaAsociada || "General";

      if (!porLinea[lineaNombre]) {
        porLinea[lineaNombre] = new Map();
      }

      const clave = d.defecto.clave;
      const actual = porLinea[lineaNombre].get(clave) || {
        clave,
        defecto: d.defecto.defecto,
        defectos: 0,
      };
      actual.defectos += 1;
      porLinea[lineaNombre].set(clave, actual);
    }

    const topSemanal: Record<string, Array<{ clave: number; defecto: string; defectos: number }>> = {};
    for (const [lin, map] of Object.entries(porLinea)) {
      topSemanal[lin] = Array.from(map.values())
        .sort((a, b) => b.defectos - a.defectos)
        .slice(0, 10);
    }

    return { contadoresDeptoHoy, topSemanal };
  }
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
   * - `soloPropiaDeUsuarioId`: si se indica, devuelve la inspección si pertenece a ese inspector,
   *   o si pertenece a la terminal activa (`terminalPermitidaId`) o departamentos de alcance (`departamentosPermitidosIds`).
   * - `incluirEliminados`: incluye defectos con borrado lógico (requiere permiso en la capa de ruta).
   * - `incluirTrazabilidad`: incluye eventos de auditoría de la inspección y sus defectos.
   */
  async getDetalleInspeccion(
    id: number,
    opts: {
      soloPropiaDeUsuarioId?: number;
      departamentosPermitidosIds?: number[];
      terminalPermitidaId?: number;
      incluirEliminados: boolean;
      incluirTrazabilidad: boolean;
    }
  ) {
    const scopeOr: any[] = [];
    if (opts.soloPropiaDeUsuarioId) {
      scopeOr.push({ inspectorId: opts.soloPropiaDeUsuarioId });
      if (opts.departamentosPermitidosIds && opts.departamentosPermitidosIds.length > 0) {
        scopeOr.push({ departamentoAuditoriaId: { in: opts.departamentosPermitidosIds } });
      }
      if (opts.terminalPermitidaId) {
        scopeOr.push({ terminalId: opts.terminalPermitidaId });
      }
    }

    const inspeccion = await prisma.inspeccionCabecera.findFirst({
      where: {
        id,
        eliminadoEn: null,
        ...(scopeOr.length > 0 ? { OR: scopeOr } : {}),
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
   * Compara el payload entrante contra una inspección existente para distinguir un reintento legítimo
   * de una colisión o alteración de payload bajo la misma clave de idempotencia.
   */
  private esPayloadEquivalente(
    previa: {
      lote: { lote: string };
      lineaId: number | null;
      detalles: Array<{ defecto: { id: number }; paresDefectuosos: number }>;
    },
    entrante: {
      lote: string;
      lineaId?: number | null;
      detalles: ItemDefectoInput[];
    },
  ): boolean {
    if (previa.lote.lote.trim().toUpperCase() !== entrante.lote.trim().toUpperCase()) {
      return false;
    }
    const prevLineaId = previa.lineaId ?? null;
    const nextLineaId = entrante.lineaId ?? null;
    if (prevLineaId !== nextLineaId) {
      return false;
    }
    if (previa.detalles.length !== entrante.detalles.length) {
      return false;
    }
    const prevSorted = [...previa.detalles]
      .map((d) => `${d.defecto.id}:${d.paresDefectuosos}`)
      .sort()
      .join("|");
    const nextSorted = [...entrante.detalles]
      .map((d) => `${d.defectoId}:${d.paresDefectuosos}`)
      .sort()
      .join("|");
    return prevSorted === nextSorted;
  }

  /**
   * Igual que createInspeccion, pero indica si la respuesta corresponde a un reintento idempotente
   * y garantiza la reconciliación idempotente hacia el archivo TXT legacy del departamento.
   */
  async registrarInspeccion(params: CreateInspeccionParams): Promise<{
    inspeccion: any;
    repetida: boolean;
    legacyResult: LegacyWriteResult;
  }> {
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
      estadoCabecera,
    } = params;

    // Idempotencia: si la misma clave ya produjo una inspección de este inspector, se verifica
    // que el payload sea equivalente. Si difiere, se rechaza con 409 ConflictError.
    if (claveIdempotencia) {
      const previa = await this.buscarPorClaveIdempotencia(usuarioId, claveIdempotencia);
      if (previa) {
        if (!this.esPayloadEquivalente(previa as any, { lote: codigoLote, lineaId, detalles })) {
          throw new ConflictError(
            `Conflicto de idempotencia: la clave '${claveIdempotencia}' ya fue utilizada por este inspector con un contenido de inspección diferente.`,
          );
        }
        const legacyResult = await inspeccionesLegacyService.ensureLegacySynced(previa as any);
        return { inspeccion: previa, repetida: true, legacyResult };
      }
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

    // Validar matriz de visibilidad / etapas de detección: verificar si cada defecto está permitido en deptoAuditoriaId
    const deptoAuditoria = await prisma.departamento.findUnique({
      where: { id: deptoAuditoriaId },
      select: { id: true, codigo: true, nombre: true },
    });

    const defectosMap = new Map(defectosEncontrados.map((d) => [d.id, d]));
    for (const defId of defectosIds) {
      const def = defectosMap.get(defId)!;
      // Resolución unificada: excepción individual > matriz maestra departamento > compatibilidad
      const excepcion = def.etapas[0]?.permitido;
      const resVisibilidad = await matrizVisibilidadDefectosService.resolverVisibilidadConEntidades(
        def.departamentoId,
        deptoAuditoriaId,
        excepcion,
        def.id
      );

      if (!resVisibilidad.permitido) {
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
          estado: estadoCabecera || "RECHAZADO",
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
        const legacyResult = await inspeccionesLegacyService.ensureLegacySynced(inspeccion as any);
        return { inspeccion, repetida: false, legacyResult };
      } catch (error: any) {
        if (error?.code !== "P2002") throw error;
        if (claveIdempotencia) {
          const previa = await this.buscarPorClaveIdempotencia(usuarioId, claveIdempotencia);
          if (previa) {
            if (!this.esPayloadEquivalente(previa as any, { lote: codigoLote, lineaId, detalles })) {
              throw new ConflictError(
                `Conflicto de idempotencia: la clave '${claveIdempotencia}' ya fue utilizada por este inspector con un contenido de inspección diferente.`,
              );
            }
            const legacyResult = await inspeccionesLegacyService.ensureLegacySynced(previa as any);
            return { inspeccion: previa, repetida: true, legacyResult };
          }
        }
        if (intento >= MAX_INTENTOS) {
          throw new BadRequestError("No fue posible asignar un folio único a la inspección. Intente nuevamente.");
        }
      }
    }
  }

  /**
   * Sincroniza un lote de capturas realizadas en modo offline desde una terminal física vinculada.
   * - MySQL (`inspecciones_cabecera` + `inspecciones_detalle`) es la fuente principal y definitiva de las nuevas capturas.
   * - Soporta múltiples inspectores distintos dentro de la misma cola de una PC compartida.
   * - Verifica la firma HMAC-SHA256 del `offlineToken` de cada captura.
   * - Verifica la autoría (`token.sub === item.inspectorId`) y la terminal (`token.terminalId === terminal.id`).
   * - NOTA DE SEGURIDAD SOBRE LA HORA DEL DISPOSITIVO: La fecha declarada por el navegador (`fechaCapturaDispositivo`)
   *   y los datos almacenados en IndexedDB NO constituyen una prueba criptográfica del instante real de captura;
   *   el reloj monotónico local solo mitiga retrocesos accidentales o casuales del reloj del cliente.
   *   La seguridad real descansa en el secreto HMAC del servidor, el aislamiento de la terminal vinculada
   *   y la auditoría explícita de cualquier captura recibida tras el vencimiento de `exp`.
   * - Maneja inspectores desactivados o sin permiso durante la desconexión: no reactiva la cuenta, pero
   *   preserva la captura histórica en estado `PENDIENTE` (requiere revisión de auditoría) para no perder datos.
   * - Garantiza idempotencia estricta en MySQL. Si la exportación legacy opcional (`LEGACY_TXT_EXPORT_ENABLED=true`)
   *   está habilitada y falla en disco, NUNCA invalida ni fuerza el reintento de una captura ya confirmada en MySQL.
   */
  async sincronizarLoteOffline(params: {
    items: SyncOfflineItemInput[];
    terminal: { id: number; nombre: string; departamentoId: number };
    reqInfo?: { ip?: string; userAgent?: string; method?: string; url?: string };
  }): Promise<{
    resultados: SyncOfflineItemResult[];
    resumen: {
      total: number;
      sincronizadas: number;
      repetidasIdempotentes: number;
      requierenRevision: number;
      rechazadas: number;
      erroresReintentables: number;
    };
  }> {
    const resultados: SyncOfflineItemResult[] = [];
    const { items, terminal, reqInfo } = params;

    for (const item of items) {
      try {
        // 1. Validar firma criptográfica del offlineToken (permitiendo detectar expiración diferida)
        let verifiedToken;
        try {
          verifiedToken = offlineAuthService.verifyOfflineTokenDetailed(item.offlineToken, {
            allowExpiredForSync: true,
          });
        } catch (err: any) {
          resultados.push({
            idLocalCliente: item.idLocalCliente,
            inspectorId: item.inspectorId,
            estado: "RECHAZADA",
            legacySincronizado: false,
            mensaje: err?.message || "Token offline inválido o manipulado",
            codigoHttp: 401,
          });
          continue;
        }

        const { payload: tokenPayload, expired: tokenExpiradoEnServidor } = verifiedToken;

        // 2. Validar correspondencia estricta de inspector y terminal física
        if (tokenPayload.sub !== item.inspectorId) {
          resultados.push({
            idLocalCliente: item.idLocalCliente,
            inspectorId: item.inspectorId,
            estado: "RECHAZADA",
            legacySincronizado: false,
            mensaje: "Suplantación detectada: el token offline no pertenece al inspector declarado en la captura",
            codigoHttp: 403,
          });
          continue;
        }

        if (tokenPayload.terminalId !== terminal.id || tokenPayload.departamentoId !== terminal.departamentoId) {
          resultados.push({
            idLocalCliente: item.idLocalCliente,
            inspectorId: item.inspectorId,
            estado: "RECHAZADA",
            legacySincronizado: false,
            mensaje: "El token offline pertenece a una terminal o departamento distinto a esta estación física",
            codigoHttp: 403,
          });
          continue;
        }

        // 3. Evaluar instante de captura frente a la ventana de vigencia de 48 horas del token
        const fechaCapturaMs = Date.parse(item.fechaCapturaDispositivo);
        const capturaSec = Number.isNaN(fechaCapturaMs)
          ? Math.floor(Date.now() / 1000)
          : Math.floor(fechaCapturaMs / 1000);

        // Si el reloj del dispositivo indica que fue capturada DESPUÉS de que venció la ventana de 48h:
        if (capturaSec > tokenPayload.exp) {
          await auditService.registrarEvento({
            accion: "INSPECCION_OFFLINE_RECHAZADA_TOKEN_VENCIDO_EN_CAPTURA",
            modulo: "SINCRONIZACION_OFFLINE",
            entidad: "cola_inspecciones",
            entidadId: item.idLocalCliente,
            descripcion: `Captura offline ${item.idLocalCliente} rechazada por realizarse con autorización offline ya vencida.`,
            valoresPosteriores: {
              idLocalCliente: item.idLocalCliente,
              inspectorId: item.inspectorId,
              fechaCapturaDispositivo: item.fechaCapturaDispositivo,
              tokenExp: tokenPayload.exp,
            },
            contexto: {
              usuarioId: item.inspectorId,
              departamentoId: terminal.departamentoId,
              terminalId: terminal.id,
              ipOrigen: reqInfo?.ip,
              agenteUsuario: reqInfo?.userAgent,
              metodoHttp: reqInfo?.method,
              rutaHttp: reqInfo?.url,
            },
          });

          resultados.push({
            idLocalCliente: item.idLocalCliente,
            inspectorId: item.inspectorId,
            estado: "RECHAZADA",
            legacySincronizado: false,
            mensaje: "La captura fue realizada después de que expiró la autorización offline de 48 horas",
            codigoHttp: 401,
          });
          continue;
        }

        // 4. Verificar estado actual del inspector en MySQL (activo, rol INSPECTOR, permiso defectos.capturar)
        const usuarioDb = await prisma.usuario.findUnique({
          where: { id: item.inspectorId },
          include: { rol: true },
        });

        if (!usuarioDb) {
          resultados.push({
            idLocalCliente: item.idLocalCliente,
            inspectorId: item.inspectorId,
            estado: "RECHAZADA",
            legacySincronizado: false,
            mensaje: "El usuario inspector no existe en el sistema",
            codigoHttp: 404,
          });
          continue;
        }

        const efectivos = await permissionsService.getPermisosEfectivos(usuarioDb.id);
        const permisosActuales = efectivos.permisos;
        const inspectorSigueActivo =
          usuarioDb.estado === "ACTIVO" &&
          usuarioDb.rol?.estado === "ACTIVO" &&
          usuarioDb.rol?.codigo.toUpperCase() === "INSPECTOR" &&
          permisosActuales.includes("defectos.capturar");

        let requiereRevision = false;
        let motivoRevision: string | undefined;

        if (!inspectorSigueActivo) {
          // Regla 4.B.6 y 6.D.5: Si el inspector fue desactivado mientras había capturas pendientes,
          // no se reactiva la cuenta, pero NO se pierden las capturas históricas hechas durante una ventana válida:
          // se registran con bandera de revisión (estado PENDIENTE) y evento de auditoría.
          requiereRevision = true;
          motivoRevision = `El inspector '${usuarioDb.usuario}' fue desactivado o sus permisos cambiaron antes de la sincronización.`;
        } else if (tokenExpiradoEnServidor) {
          // Captura realizada dentro de las 48h válidas, pero la red tardó >48h en volver
          motivoRevision = "Sincronizada tras el vencimiento del token offline (capturada dentro de la ventana válida de 48h).";
        }

        if (item.esContingencia) {
          requiereRevision = true;
          motivoRevision = motivoRevision
            ? `${motivoRevision} | Contingencia: ${item.motivoContingencia || "Sin detalle"}`
            : `Captura en contingencia: ${item.motivoContingencia || "Lote no localizado en catálogo local"}`;
        }

        // 5. Ejecutar registro idempotente en MySQL + reconciliación legacy TXT
        const { inspeccion, repetida, legacyResult } = await this.registrarInspeccion({
          lote: item.payload.lote,
          lineaId: item.payload.lineaId,
          lineaTexto: item.payload.lineaTexto,
          horma: item.payload.horma,
          notas: motivoRevision
            ? `${item.payload.notas ? `${item.payload.notas} | ` : ""}[OFFLINE: ${motivoRevision}]`.slice(0, 500)
            : item.payload.notas,
          detalles: item.payload.detalles,
          usuarioId: item.inspectorId,
          claveIdempotencia: item.idLocalCliente,
          estadoCabecera: requiereRevision ? "PENDIENTE" : "RECHAZADO",
          terminal,
          reqInfo,
        });

        if (requiereRevision || tokenExpiradoEnServidor) {
          await auditService.registrarEvento({
            accion: !inspectorSigueActivo
              ? "INSPECCION_OFFLINE_INSPECTOR_DESACTIVADO_REVISION"
              : item.esContingencia
              ? "INSPECCION_OFFLINE_CONTINGENCIA_REGISTRADA"
              : "INSPECCION_OFFLINE_SINCRONIZADA_POST_EXPIRACION",
            modulo: "SINCRONIZACION_OFFLINE",
            entidad: "inspeccion_cabecera",
            entidadId: String(inspeccion.id),
            descripcion: motivoRevision || "Inspección offline sincronizada con observación",
            valoresPosteriores: {
              inspeccionId: inspeccion.id,
              folio: inspeccion.folio,
              idLocalCliente: item.idLocalCliente,
              inspectorId: item.inspectorId,
              inspectorEstadoActual: usuarioDb.estado,
              tokenExpiradoEnServidor,
              esContingencia: Boolean(item.esContingencia),
            },
            contexto: {
              usuarioId: item.inspectorId,
              departamentoId: terminal.departamentoId,
              terminalId: terminal.id,
              ipOrigen: reqInfo?.ip,
              agenteUsuario: reqInfo?.userAgent,
              metodoHttp: reqInfo?.method,
              rutaHttp: reqInfo?.url,
            },
          });
        }

        // MySQL es la fuente principal y definitiva de las nuevas capturas.
        // Una vez confirmada la transacción en MySQL (o detectado el reintento idempotente en MySQL),
        // la captura queda confirmada (`SINCRONIZADA` o `REPETIDA_IDEMPOTENTE`).
        // Un fallo en la exportación TXT legacy opcional jamás invalida ni fuerza el reintento de MySQL.
        resultados.push({
          idLocalCliente: item.idLocalCliente,
          inspectorId: item.inspectorId,
          estado: repetida ? "REPETIDA_IDEMPOTENTE" : "SINCRONIZADA",
          folio: inspeccion.folio,
          inspeccionId: inspeccion.id,
          legacySincronizado: legacyResult.sincronizado,
          yaEstabaLegacy: legacyResult.yaEstabaSincronizado,
          requiereRevision,
          motivoRevision,
          mensaje: repetida
            ? "Inspección ya sincronizada previamente en MySQL (idempotente)"
            : "Inspección sincronizada exitosamente en MySQL",
          codigoHttp: repetida ? 200 : 201,
        });
      } catch (err: any) {
        if (err instanceof ConflictError) {
          resultados.push({
            idLocalCliente: item.idLocalCliente,
            inspectorId: item.inspectorId,
            estado: "CONFLICTO_IDEMPOTENCIA",
            legacySincronizado: false,
            mensaje: err.message,
            codigoHttp: 409,
          });
        } else if (err instanceof NotFoundError && item.esContingencia) {
          // Si fue capturada en contingencia porque el lote no estaba en el catálogo y aún no ha sido cargado en MySQL:
          await auditService.registrarEvento({
            accion: "INSPECCION_OFFLINE_LOTE_PENDIENTE_REVISION",
            modulo: "SINCRONIZACION_OFFLINE",
            entidad: "cola_inspecciones",
            entidadId: item.idLocalCliente,
            descripcion: `Captura en contingencia ${item.idLocalCliente} para lote '${item.payload.lote}' requiere alta del lote en producción.`,
            motivo: item.motivoContingencia || "Contingencia de lote offline",
            valoresPosteriores: {
              idLocalCliente: item.idLocalCliente,
              lote: item.payload.lote,
              inspectorId: item.inspectorId,
              detalles: item.payload.detalles,
            },
            contexto: {
              usuarioId: item.inspectorId,
              departamentoId: terminal.departamentoId,
              terminalId: terminal.id,
              ipOrigen: reqInfo?.ip,
              agenteUsuario: reqInfo?.userAgent,
              metodoHttp: reqInfo?.method,
              rutaHttp: reqInfo?.url,
            },
          });

          resultados.push({
            idLocalCliente: item.idLocalCliente,
            inspectorId: item.inspectorId,
            estado: "REQUIERE_REVISION",
            legacySincronizado: false,
            requiereRevision: true,
            motivoRevision: err.message,
            mensaje: `${err.message} Conservada en contingencia para revisión cuando el lote sea dado de alta.`,
            codigoHttp: 422,
          });
        } else if (err instanceof BadRequestError || err instanceof NotFoundError || err instanceof ForbiddenError || err instanceof UnauthorizedError) {
          // Si el rechazo se debe a una regla de visibilidad de defecto cambiada mientras estaba offline,
          // no descartar destructivamente el registro: marcarlo para revisión de auditoría
          const esConflictoVisibilidad =
            err instanceof BadRequestError &&
            typeof err.message === "string" &&
            err.message.includes("no está permitido para inspección en la etapa");

          if (esConflictoVisibilidad) {
            await auditService.registrarEvento({
              accion: "INSPECCION_OFFLINE_VISIBILIDAD_ALTERADA_REVISION",
              modulo: "SINCRONIZACION_OFFLINE",
              entidad: "cola_inspecciones",
              entidadId: item.idLocalCliente,
              descripcion: `Captura offline ${item.idLocalCliente} contiene defecto con permiso alterado en servidor: ${err.message}`,
              motivo: err.message,
              valoresPosteriores: {
                idLocalCliente: item.idLocalCliente,
                lote: item.payload.lote,
                inspectorId: item.inspectorId,
                detalles: item.payload.detalles,
              },
              contexto: {
                usuarioId: item.inspectorId,
                departamentoId: terminal.departamentoId,
                terminalId: terminal.id,
                ipOrigen: reqInfo?.ip,
                agenteUsuario: reqInfo?.userAgent,
                metodoHttp: reqInfo?.method,
                rutaHttp: reqInfo?.url,
              },
            });

            resultados.push({
              idLocalCliente: item.idLocalCliente,
              inspectorId: item.inspectorId,
              estado: "REQUIERE_REVISION",
              legacySincronizado: false,
              requiereRevision: true,
              motivoRevision: `Conflicto de visibilidad de defecto: ${err.message}`,
              mensaje: `${err.message} Captura conservada para revisión de auditoría (el permiso cambió en el servidor mientras la terminal estaba offline).`,
              codigoHttp: 422,
            });
          } else {
            resultados.push({
              idLocalCliente: item.idLocalCliente,
              inspectorId: item.inspectorId,
              estado: "RECHAZADA",
              legacySincronizado: false,
              mensaje: err.message,
              codigoHttp: err.statusCode || 400,
            });
          }
        } else {
          resultados.push({
            idLocalCliente: item.idLocalCliente,
            inspectorId: item.inspectorId,
            estado: "ERROR_REINTENTABLE",
            legacySincronizado: false,
            mensaje: err?.message || "Error temporal al sincronizar la inspección",
            codigoHttp: 500,
          });
        }
      }
    }

    const resumen = {
      total: resultados.length,
      sincronizadas: resultados.filter((r) => r.estado === "SINCRONIZADA").length,
      repetidasIdempotentes: resultados.filter((r) => r.estado === "REPETIDA_IDEMPOTENTE").length,
      requierenRevision: resultados.filter((r) => r.estado === "REQUIERE_REVISION" || r.requiereRevision).length,
      rechazadas: resultados.filter((r) => r.estado === "RECHAZADA" || r.estado === "CONFLICTO_IDEMPOTENCIA").length,
      erroresReintentables: resultados.filter((r) => r.estado === "ERROR_REINTENTABLE").length,
    };

    return { resultados, resumen };
  }

  /**
   * Valida que los filtros departamentales solicitados no excedan el alcance autorizado del usuario.
   */
  private validarAlcanceDepartamental(params: {
    departamentoId?: number;
    departamentoAuditoriaId?: number;
    departamentoResponsableId?: number;
    departamentosPermitidosIds?: number[];
    alcanceRestringido?: {
      usuarioId: number;
      departamentosIds?: number[];
      terminalId?: number;
    };
  }): void {
    const permitidos =
      params.departamentosPermitidosIds && params.departamentosPermitidosIds.length > 0
        ? params.departamentosPermitidosIds
        : params.alcanceRestringido?.departamentosIds && params.alcanceRestringido.departamentosIds.length > 0
        ? params.alcanceRestringido.departamentosIds
        : undefined;

    if (!permitidos) return;

    if (params.departamentoId && !permitidos.includes(params.departamentoId)) {
      throw new ForbiddenError("Acceso denegado: no tiene permiso para consultar registros de otro departamento");
    }
    if (params.departamentoAuditoriaId && !permitidos.includes(params.departamentoAuditoriaId)) {
      throw new ForbiddenError("Acceso denegado: no tiene permiso para consultar registros de otro departamento");
    }
    if (
      params.departamentosPermitidosIds &&
      params.departamentosPermitidosIds.length > 0 &&
      params.departamentoResponsableId &&
      !permitidos.includes(params.departamentoResponsableId)
    ) {
      throw new ForbiddenError("Acceso denegado: no tiene permiso para consultar registros de otro departamento");
    }
  }

  /**
   * Resuelve el intervalo semiabierto `[inicioUtc, finUtc)` en UTC (`fecha >= inicioUtc && fecha < finUtc`)
   * interpretando los parámetros operativos en la zona horaria `America/Mexico_City` (UTC-6).
   */
  public resolverFiltroTemporalUtc(params: FiltrosBaseInspeccionesParams): {
    periodoEfectivo: ModalidadPeriodoInspeccion;
    inicioUtc?: Date;
    finUtc?: Date;
  } {
    const partesHoy = getPartesFechaMexico();
    const hoyStr = partesHoy.fechaStr;
    const { finUtc: finHoyUtc } = getRangoDiaUtc(hoyStr);

    // Normalizar fechaDesde / fechaHasta si vienen como string (AAAA-MM-DD) o como Date
    const tieneRangoExplicito = Boolean(params.fechaDesde || params.fechaHasta || params.periodo === "rango");
    if (tieneRangoExplicito) {
      let inicioUtc: Date | undefined;
      let finUtc: Date | undefined;

      if (typeof params.fechaDesde === "string") {
        inicioUtc = getRangoDiaUtc(params.fechaDesde).inicioUtc;
      } else if (params.fechaDesde instanceof Date) {
        inicioUtc = params.fechaDesde;
      }

      if (typeof params.fechaHasta === "string") {
        finUtc = getRangoDiaUtc(params.fechaHasta).finUtc;
      } else if (params.fechaHasta instanceof Date) {
        finUtc = params.fechaHasta;
      }

      if (finUtc && finUtc.getTime() > finHoyUtc.getTime()) {
        finUtc = finHoyUtc;
      }

      return {
        periodoEfectivo: params.periodo === "rango" ? "rango" : "todos",
        inicioUtc,
        finUtc: finUtc ?? finHoyUtc,
      };
    }

    // Día específico (`dia=AAAA-MM-DD` o `periodo=dia`)
    if (params.dia) {
      const { inicioUtc, finUtc } = getRangoDiaUtc(params.dia);
      return {
        periodoEfectivo: params.periodo === "dia" ? "dia" : "todos",
        inicioUtc,
        finUtc: finUtc.getTime() > finHoyUtc.getTime() ? finHoyUtc : finUtc,
      };
    }

    // Semana ISO 8601 (`semana=1..53` + `anioIso`/`anio` o `periodo=semana`)
    if (params.semana !== undefined) {
      const isoHoy = getIsoYearAndWeek(hoyStr);
      const anioIso = params.anioIso || params.anio || isoHoy.anioIso;
      const { inicioUtc, finUtc } = getRangoSemanaIsoUtc(anioIso, params.semana);
      return {
        periodoEfectivo: params.periodo === "semana" ? "semana" : "todos",
        inicioUtc,
        finUtc: finUtc.getTime() > finHoyUtc.getTime() ? finHoyUtc : finUtc,
      };
    }

    const periodo = params.periodo || "ultimos";

    if (params.soloEliminados && periodo === "ultimos" && !params.mes && !params.anio) {
      return { periodoEfectivo: "ultimos" };
    }

    if (periodo === "hoy") {
      const { inicioUtc, finUtc } = getRangoDiaUtc(hoyStr);
      return {
        periodoEfectivo: "hoy",
        inicioUtc,
        finUtc,
      };
    }

    // Mes específico (`periodo=mes` o `periodo=todos` con `mes`)
    if (periodo === "mes" || (params.mes !== undefined && (periodo === "todos" || periodo === "anio"))) {
      const anio = params.anio || partesHoy.anio;
      const { inicioUtc, finUtc } = getRangoMesUtc(anio, params.mes!);
      return {
        periodoEfectivo: periodo === "mes" ? "mes" : "todos",
        inicioUtc,
        finUtc: finUtc.getTime() > finHoyUtc.getTime() ? finHoyUtc : finUtc,
      };
    }

    // Año completo (`periodo=anio` o `periodo=todos` con `anio` sin `mes`)
    if (periodo === "anio" || (params.anio !== undefined && periodo === "todos")) {
      const anio = params.anio!;
      const { inicioUtc, finUtc } = getRangoAnioUtc(anio);
      return {
        periodoEfectivo: periodo === "anio" ? "anio" : "todos",
        inicioUtc,
        finUtc: finUtc.getTime() > finHoyUtc.getTime() ? finHoyUtc : finUtc,
      };
    }

    if (periodo === "todos") {
      return {
        periodoEfectivo: "todos",
        finUtc: params.soloEliminados ? undefined : finHoyUtc,
      };
    }

    return {
      periodoEfectivo: "ultimos",
    };
  }

  /**
   * Construye la condición Prisma `where` unificada tanto para `getFilasInspeccion` como para `exportarFilasInspeccion`.
   */
  private construirWhereFilasInspeccion(params: FiltrosBaseInspeccionesParams): {
    where: Record<string, unknown>;
    periodo: ModalidadPeriodoInspeccion;
  } {
    this.validarAlcanceDepartamental(params);

    const where: Record<string, unknown> = {
      eliminadoEn: params.soloEliminados ? { not: null } : null,
      inspeccion: {},
    };

    const andConditions: any[] = [];

    // 1. Restricción de alcance departamental si el usuario tiene departamentos acotados
    if (params.departamentosPermitidosIds && params.departamentosPermitidosIds.length > 0) {
      andConditions.push({
        OR: [
          { inspeccion: { departamentoAuditoriaId: { in: params.departamentosPermitidosIds } } },
          { defDeptoId: { in: params.departamentosPermitidosIds } },
        ],
      });
    }

    // 2. Filtro explícito por departamento auditor, responsable o unificado
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
      where.defecto = { ...((where.defecto as any) || {}), clasificacion: params.clasificacion };
    }

    if (params.lineaId) {
      (where.inspeccion as any).lineaId = params.lineaId;
    }

    if (params.lineaTexto) {
      (where.inspeccion as any).lineaTexto = params.lineaTexto;
    }

    if (params.inspectorId) {
      (where.inspeccion as any).inspectorId = params.inspectorId;
    } else if (params.alcanceRestringido) {
      const { usuarioId, departamentosIds, terminalId: termId } = params.alcanceRestringido;
      const scopeOr: any[] = [{ inspeccion: { inspectorId: usuarioId } }];
      if (departamentosIds && departamentosIds.length > 0) {
        scopeOr.push({ inspeccion: { departamentoAuditoriaId: { in: departamentosIds } } });
      }
      if (termId) {
        scopeOr.push({ inspeccion: { terminalId: termId } });
      }
      andConditions.push({ OR: scopeOr });
    }

    if (params.terminalId) {
      (where.inspeccion as any).terminalId = params.terminalId;
    }

    // 3. Filtro temporal con intervalos semiabiertos [inicioUtc, finUtc) en America/Mexico_City
    const { periodoEfectivo, inicioUtc, finUtc } = this.resolverFiltroTemporalUtc(params);
    if (inicioUtc || finUtc) {
      (where.inspeccion as any).fechaInspeccion = {
        ...(inicioUtc ? { gte: inicioUtc } : {}),
        ...(finUtc ? { lt: finUtc } : {}),
      };
    }

    // 4. Búsqueda por Lote, Modelo, Lista, Cliente o Defecto
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
      where.defecto = { ...((where.defecto as any) || {}), clave: params.defectoClave };
    }

    return { where, periodo: periodoEfectivo };
  }

  private readonly includeDetalleFila = {
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
  } as const;

  private async mapearDetallesAFilas(detalles: any[]) {
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

    return detalles.map((d) => ({
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
      inspectorId: d.inspeccion.inspectorId,
      usuario: d.inspeccion.inspector.nombre || d.inspeccion.inspector.usuario,
      terminal: d.inspeccion.terminal?.nombre ?? null,
      terminalId: d.inspeccion.terminal?.id ?? null,
      eliminadoEn: d.eliminadoEn,
      eliminadoPor: d.eliminadoPor,
      eliminadoPorNombre: d.eliminadoPor ? mapEliminadores.get(d.eliminadoPor) || `Usuario #${d.eliminadoPor}` : null,
      eliminadoMotivo: d.eliminadoMotivo,
    }));
  }

  /**
   * Consulta a nivel de cada defecto registrado (fila unitaria como en el sistema original).
   * Soporta modalidades: 'hoy', 'ultimos', 'todos', 'anio', 'mes', 'semana', 'dia', 'rango'.
   * Distingue explícitamente entre `total` / `totalDefectos` (incidencias) y `totalInspecciones` (sesiones de lote).
   */
  async getFilasInspeccion(params: GetInspeccionesParams) {
    const { where, periodo } = this.construirWhereFilasInspeccion(params);

    const esUltimos = !params.soloEliminados && periodo === "ultimos";
    const take = esUltimos ? 30 : params.limit;
    const skip = esUltimos ? 0 : (params.page - 1) * take;

    const [detalles, total, totalInspeccionesCount] = await Promise.all([
      prisma.inspeccionDetalle.findMany({
        where,
        skip,
        take,
        orderBy: [
          { inspeccion: { fechaInspeccion: "desc" } },
          { id: "desc" },
        ],
        include: this.includeDetalleFila,
      }),
      prisma.inspeccionDetalle.count({ where }),
      esUltimos
        ? Promise.resolve(0)
        : prisma.inspeccionCabecera.count({
            where: {
              detalles: { some: where },
            },
          }),
    ]);

    const items = await this.mapearDetallesAFilas(detalles);
    const effectiveTotal = esUltimos ? Math.min(30, total) : total;
    const effectiveTotalInspecciones = esUltimos
      ? new Set(items.map((i) => i.inspeccionId)).size
      : totalInspeccionesCount;

    return {
      items,
      total: effectiveTotal,
      totalDefectos: effectiveTotal,
      totalInspecciones: effectiveTotalInspecciones,
      periodo,
      page: esUltimos ? 1 : params.page,
      limit: take,
      totalPages: esUltimos ? 1 : Math.ceil(total / take) || 1,
    };
  }

  /**
   * Obtiene la totalidad de los registros de defectos correspondientes a los filtros seleccionados
   * mediante lectura paginada por lotes internos (sin truncamiento silencioso), garantizando
   * correspondencia 1:1 entre la consulta y la exportación.
   */
  async exportarFilasInspeccion(params: FiltrosBaseInspeccionesParams) {
    const { where, periodo } = this.construirWhereFilasInspeccion(params);
    const esUltimos = !params.soloEliminados && periodo === "ultimos";

    if (esUltimos) {
      const detalles = await prisma.inspeccionDetalle.findMany({
        where,
        take: 30,
        skip: 0,
        orderBy: [
          { inspeccion: { fechaInspeccion: "desc" } },
          { id: "desc" },
        ],
        include: this.includeDetalleFila,
      });
      const items = await this.mapearDetallesAFilas(detalles);
      const totalInspecciones = new Set(items.map((i) => i.inspeccionId)).size;
      const totalParesDefectuosos = items.reduce((acc, i) => acc + i.paresDefectuosos, 0);
      return {
        items,
        total: items.length,
        totalDefectos: items.length,
        totalInspecciones,
        totalParesDefectuosos,
        periodo,
      };
    }

    const BATCH_SIZE = 2000;
    const todosDetalles: any[] = [];
    let offset = 0;

    while (true) {
      const lote = await prisma.inspeccionDetalle.findMany({
        where,
        skip: offset,
        take: BATCH_SIZE,
        orderBy: [
          { inspeccion: { fechaInspeccion: "desc" } },
          { id: "desc" },
        ],
        include: this.includeDetalleFila,
      });

      if (lote.length === 0) break;
      todosDetalles.push(...lote);
      if (lote.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }

    const items = await this.mapearDetallesAFilas(todosDetalles);
    const totalInspecciones = new Set(items.map((i) => i.inspeccionId)).size;
    const totalParesDefectuosos = items.reduce((acc, i) => acc + i.paresDefectuosos, 0);

    return {
      items,
      total: items.length,
      totalDefectos: items.length,
      totalInspecciones,
      totalParesDefectuosos,
      periodo,
    };
  }

  /**
   * Obtiene los periodos disponibles con registros reales en la base de datos (sin periodos vacíos ni futuros),
   * respetando el alcance departamental, permisos y filtros de borrado lógico.
   *
   * Todas las agrupaciones temporales se evalúan en la zona horaria operativa `America/Mexico_City` (UTC-6)
   * y las semanas se identifican conjuntamente mediante Año ISO + Semana ISO (`YEARWEEK(..., 3)`).
   */
  async getPeriodosDisponibles(params: GetPeriodosDisponiblesParams = {}) {
    this.validarAlcanceDepartamental(params);

    const partesHoy = getPartesFechaMexico();
    const hoyStr = partesHoy.fechaStr;
    const isoHoy = getIsoYearAndWeek(hoyStr);
    const { finUtc: finHoyUtc } = getRangoDiaUtc(hoyStr);

    const conditions: Prisma.Sql[] = [];

    if (params.soloEliminados) {
      conditions.push(Prisma.sql`d.eliminado_en IS NOT NULL`);
    } else {
      conditions.push(Prisma.sql`d.eliminado_en IS NULL AND c.eliminado_en IS NULL`);
    }

    // Regla crítica: nunca considerar registros con fechas futuras
    conditions.push(Prisma.sql`c.fecha_inspeccion < ${finHoyUtc} AND c.fecha_inspeccion <= NOW()`);

    // Alcance departamental del usuario
    if (params.departamentosPermitidosIds && params.departamentosPermitidosIds.length > 0) {
      const idsSql = Prisma.join(params.departamentosPermitidosIds);
      conditions.push(
        Prisma.sql`(c.departamento_auditoria_id IN (${idsSql}) OR d.def_depto_id IN (${idsSql}))`
      );
    }

    if (params.departamentoId) {
      conditions.push(
        Prisma.sql`(c.departamento_auditoria_id = ${params.departamentoId} OR d.def_depto_id = ${params.departamentoId})`
      );
    } else {
      if (params.departamentoAuditoriaId) {
        conditions.push(Prisma.sql`c.departamento_auditoria_id = ${params.departamentoAuditoriaId}`);
      }
      if (params.departamentoResponsableId) {
        conditions.push(Prisma.sql`d.def_depto_id = ${params.departamentoResponsableId}`);
      }
    }

    if (params.inspectorId) {
      conditions.push(Prisma.sql`c.inspector_id = ${params.inspectorId}`);
    } else if (params.alcanceRestringido) {
      const { usuarioId, departamentosIds, terminalId: termId } = params.alcanceRestringido;
      const scopeParts: Prisma.Sql[] = [Prisma.sql`c.inspector_id = ${usuarioId}`];
      if (departamentosIds && departamentosIds.length > 0) {
        scopeParts.push(
          Prisma.sql`c.departamento_auditoria_id IN (${Prisma.join(departamentosIds)})`
        );
      }
      if (termId) {
        scopeParts.push(Prisma.sql`c.terminal_id = ${termId}`);
      }
      conditions.push(Prisma.sql`(${Prisma.join(scopeParts, " OR ")})`);
    }

    if (params.terminalId) {
      conditions.push(Prisma.sql`c.terminal_id = ${params.terminalId}`);
    }

    if (params.lineaId) {
      conditions.push(Prisma.sql`c.linea_id = ${params.lineaId}`);
    }

    if (params.lineaTexto) {
      conditions.push(Prisma.sql`c.linea_texto = ${params.lineaTexto}`);
    }

    let requiereJoinDefecto = false;
    let requiereJoinLote = false;

    if (params.clasificacion) {
      requiereJoinDefecto = true;
      conditions.push(Prisma.sql`def.clasificacion = ${params.clasificacion}`);
    }

    if (params.defectoClave) {
      requiereJoinDefecto = true;
      conditions.push(Prisma.sql`def.clave = ${params.defectoClave}`);
    }

    if (params.lote) {
      requiereJoinLote = true;
      const likeLote = `%${params.lote.trim()}%`;
      conditions.push(Prisma.sql`l.lote LIKE ${likeLote}`);
    }

    if (params.busqueda) {
      requiereJoinDefecto = true;
      requiereJoinLote = true;
      const q = params.busqueda.trim();
      const likeQ = `%${q}%`;
      const qNum = parseInt(q, 10);
      if (!isNaN(qNum)) {
        conditions.push(
          Prisma.sql`(l.lote LIKE ${likeQ} OR l.modelo LIKE ${likeQ} OR l.lista LIKE ${likeQ} OR l.cliente LIKE ${likeQ} OR def.defecto LIKE ${likeQ} OR def.clave = ${qNum})`
        );
      } else {
        conditions.push(
          Prisma.sql`(l.lote LIKE ${likeQ} OR l.modelo LIKE ${likeQ} OR l.lista LIKE ${likeQ} OR l.cliente LIKE ${likeQ} OR def.defecto LIKE ${likeQ})`
        );
      }
    }

    const joinsSql = Prisma.sql`
      ${requiereJoinDefecto ? Prisma.sql`INNER JOIN defectos def ON def.id = d.defecto_id` : Prisma.empty}
      ${requiereJoinLote ? Prisma.sql`INNER JOIN produccion_lotes l ON l.id = c.lote_id` : Prisma.empty}
    `;

    const whereSql = Prisma.join(conditions, " AND ");

    // 1. Consulta agrupada de años civiles, años ISO y rango global con registros reales
    const resumenAniosRows = await prisma.$queryRaw<
      Array<{
        anioCivil: number | bigint;
        anioIso: number | bigint;
        fechaMin: string | null;
        fechaMax: string | null;
        totalDefectos: bigint;
        totalInspecciones: bigint;
      }>
    >(Prisma.sql`
      SELECT
        YEAR(DATE_SUB(c.fecha_inspeccion, INTERVAL 6 HOUR)) AS anioCivil,
        FLOOR(YEARWEEK(DATE_SUB(c.fecha_inspeccion, INTERVAL 6 HOUR), 3) / 100) AS anioIso,
        MIN(DATE_FORMAT(DATE_SUB(c.fecha_inspeccion, INTERVAL 6 HOUR), '%Y-%m-%d')) AS fechaMin,
        MAX(DATE_FORMAT(DATE_SUB(c.fecha_inspeccion, INTERVAL 6 HOUR), '%Y-%m-%d')) AS fechaMax,
        COUNT(d.id) AS totalDefectos,
        COUNT(DISTINCT c.id) AS totalInspecciones
      FROM inspecciones_detalle d
      INNER JOIN inspecciones_cabecera c ON c.id = d.inspeccion_id
      ${joinsSql}
      WHERE ${whereSql}
      GROUP BY anioCivil, anioIso
      ORDER BY anioCivil DESC, anioIso DESC
    `);

    const mapAniosCiviles = new Map<number, { anio: number; totalDefectos: number; totalInspecciones: number }>();
    const mapAniosIso = new Map<number, { anioIso: number; totalDefectos: number; totalInspecciones: number }>();
    let fechaMinima: string | null = null;
    let fechaMaxima: string | null = null;

    for (const r of resumenAniosRows) {
      const defCount = Number(r.totalDefectos);
      const inspCount = Number(r.totalInspecciones);
      if (defCount <= 0) continue;

      const aCivil = Number(r.anioCivil);
      const aIso = Number(r.anioIso);

      if (aCivil <= partesHoy.anio) {
        const prev = mapAniosCiviles.get(aCivil) || { anio: aCivil, totalDefectos: 0, totalInspecciones: 0 };
        prev.totalDefectos += defCount;
        prev.totalInspecciones += inspCount;
        mapAniosCiviles.set(aCivil, prev);
      }

      if (aIso <= isoHoy.anioIso) {
        const prevIso = mapAniosIso.get(aIso) || { anioIso: aIso, totalDefectos: 0, totalInspecciones: 0 };
        prevIso.totalDefectos += defCount;
        prevIso.totalInspecciones += inspCount;
        mapAniosIso.set(aIso, prevIso);
      }

      if (r.fechaMin && (!fechaMinima || r.fechaMin < fechaMinima)) {
        fechaMinima = r.fechaMin;
      }
      if (r.fechaMax) {
        const maxCapped = r.fechaMax > hoyStr ? hoyStr : r.fechaMax;
        if (!fechaMaxima || maxCapped > fechaMaxima) {
          fechaMaxima = maxCapped;
        }
      }
    }

    const anios = Array.from(mapAniosCiviles.values()).sort((a, b) => b.anio - a.anio);
    const aniosIso = Array.from(mapAniosIso.values()).sort((a, b) => b.anioIso - a.anioIso);

    const anioSeleccionado =
      params.anio !== undefined ? params.anio : anios[0]?.anio ?? null;
    const anioIsoSeleccionado =
      params.anioIso !== undefined
        ? params.anioIso
        : params.anio !== undefined
        ? params.anio
        : aniosIso[0]?.anioIso ?? null;

    // 2. Consultar en paralelo los meses de `anioSeleccionado` y las semanas ISO de `anioIsoSeleccionado`
    const promesaMeses =
      anioSeleccionado !== null && mapAniosCiviles.has(anioSeleccionado)
        ? (async () => {
            const { inicioUtc, finUtc } = getRangoAnioUtc(anioSeleccionado);
            const rows = await prisma.$queryRaw<
              Array<{ mes: number | bigint; totalDefectos: bigint; totalInspecciones: bigint }>
            >(Prisma.sql`
              SELECT
                MONTH(DATE_SUB(c.fecha_inspeccion, INTERVAL 6 HOUR)) AS mes,
                COUNT(d.id) AS totalDefectos,
                COUNT(DISTINCT c.id) AS totalInspecciones
              FROM inspecciones_detalle d
              INNER JOIN inspecciones_cabecera c ON c.id = d.inspeccion_id
              ${joinsSql}
              WHERE ${whereSql}
                AND c.fecha_inspeccion >= ${inicioUtc}
                AND c.fecha_inspeccion < ${finUtc}
              GROUP BY mes
              ORDER BY mes DESC
            `);

            return rows
              .map((r) => {
                const mesNum = Number(r.mes);
                const totalDefectos = Number(r.totalDefectos);
                const totalInspecciones = Number(r.totalInspecciones);
                const nombre = NOMBRES_MESES_ES[mesNum] || `Mes ${mesNum}`;
                return {
                  mes: mesNum,
                  anio: anioSeleccionado,
                  nombre,
                  label: `${nombre} ${anioSeleccionado}`,
                  totalDefectos,
                  totalInspecciones,
                };
              })
              .filter(
                (m) =>
                  m.totalDefectos > 0 &&
                  !(anioSeleccionado === partesHoy.anio && m.mes > partesHoy.mes)
              );
          })()
        : Promise.resolve([]);

    const promesaSemanas =
      anioIsoSeleccionado !== null && mapAniosIso.has(anioIsoSeleccionado)
        ? (async () => {
            const { inicioUtc, finUtc } = getRangoAnioIsoCompletoUtc(anioIsoSeleccionado);
            const rows = await prisma.$queryRaw<
              Array<{ yearWeekIso: number | bigint; totalDefectos: bigint; totalInspecciones: bigint }>
            >(Prisma.sql`
              SELECT
                YEARWEEK(DATE_SUB(c.fecha_inspeccion, INTERVAL 6 HOUR), 3) AS yearWeekIso,
                COUNT(d.id) AS totalDefectos,
                COUNT(DISTINCT c.id) AS totalInspecciones
              FROM inspecciones_detalle d
              INNER JOIN inspecciones_cabecera c ON c.id = d.inspeccion_id
              ${joinsSql}
              WHERE ${whereSql}
                AND c.fecha_inspeccion >= ${inicioUtc}
                AND c.fecha_inspeccion < ${finUtc}
              GROUP BY yearWeekIso
              ORDER BY yearWeekIso DESC
            `);

            return rows
              .map((r) => {
                const yw = Number(r.yearWeekIso);
                const aIso = Math.floor(yw / 100);
                const semIso = yw % 100;
                const totalDefectos = Number(r.totalDefectos);
                const totalInspecciones = Number(r.totalInspecciones);
                if (aIso !== anioIsoSeleccionado || totalDefectos <= 0) return null;

                const info = getRangoSemanaIsoUtc(aIso, semIso);
                // No mostrar semanas futuras
                if (info.fechaInicio > hoyStr) return null;

                return {
                  anioIso: aIso,
                  semana: semIso,
                  codigo: info.codigo,
                  fechaInicio: info.fechaInicio,
                  fechaFin: info.fechaFin,
                  label: info.label,
                  etiqueta: info.label,
                  totalDefectos,
                  totalInspecciones,
                };
              })
              .filter((s): s is NonNullable<typeof s> => s !== null);
          })()
        : Promise.resolve([]);

    const [meses, semanas] = await Promise.all([promesaMeses, promesaSemanas]);

    // 3. Consultar días disponibles para `(anioSeleccionado, mesSeleccionado)`
    const mesSeleccionado =
      params.mes !== undefined ? params.mes : meses[0]?.mes ?? null;

    const dias =
      anioSeleccionado !== null &&
      mesSeleccionado !== null &&
      meses.some((m) => m.mes === mesSeleccionado)
        ? await (async () => {
            const { inicioUtc, finUtc } = getRangoMesUtc(anioSeleccionado, mesSeleccionado);
            const rows = await prisma.$queryRaw<
              Array<{ fecha: string; totalDefectos: bigint; totalInspecciones: bigint }>
            >(Prisma.sql`
              SELECT
                DATE_FORMAT(DATE_SUB(c.fecha_inspeccion, INTERVAL 6 HOUR), '%Y-%m-%d') AS fecha,
                COUNT(d.id) AS totalDefectos,
                COUNT(DISTINCT c.id) AS totalInspecciones
              FROM inspecciones_detalle d
              INNER JOIN inspecciones_cabecera c ON c.id = d.inspeccion_id
              ${joinsSql}
              WHERE ${whereSql}
                AND c.fecha_inspeccion >= ${inicioUtc}
                AND c.fecha_inspeccion < ${finUtc}
              GROUP BY fecha
              ORDER BY fecha DESC
            `);

            return rows
              .filter((r) => Boolean(r.fecha) && r.fecha <= hoyStr && Number(r.totalDefectos) > 0)
              .map((r) => ({
                ...formatearDiaDisponible(r.fecha),
                totalDefectos: Number(r.totalDefectos),
                totalInspecciones: Number(r.totalInspecciones),
              }));
          })()
        : [];

    return {
      anios,
      aniosIso,
      anioSeleccionado,
      anioIsoSeleccionado,
      mesSeleccionado,
      meses,
      semanas,
      dias,
      rangoTotal: {
        fechaMinima,
        fechaMaxima,
        hoy: hoyStr,
      },
    };
  }

  /**
   * Obtiene el catálogo de inspectores para los selectores de filtros:
   * - Exclusivamente cuentas con rol `INSPECTOR` y estado `ACTIVO`.
   * - Excluye `SUPER_ADMIN`, `ADMIN`, `COORD` y usuarios inactivos.
   * - Respeta el alcance departamental autorizado y el filtro opcional `departamentoId`.
   */
  async getInspectores(params: GetInspectoresParams = {}) {
    this.validarAlcanceDepartamental({
      departamentoId: params.departamentoId,
      departamentosPermitidosIds: params.departamentosPermitidosIds,
    });

    let deptosFiltroIds: number[] | undefined;
    if (params.departamentoId) {
      deptosFiltroIds = [params.departamentoId];
    } else if (params.departamentosPermitidosIds && params.departamentosPermitidosIds.length > 0) {
      deptosFiltroIds = params.departamentosPermitidosIds;
    }

    const usuarios = await prisma.usuario.findMany({
      where: {
        estado: "ACTIVO",
        rol: {
          codigo: "INSPECTOR",
          estado: "ACTIVO",
        },
        ...(deptosFiltroIds
          ? {
              departamentos: {
                some: {
                  departamentoId: { in: deptosFiltroIds },
                  estado: "ACTIVO",
                  departamento: {
                    estado: "ACTIVO",
                    eliminadoEn: null,
                  },
                },
              },
            }
          : {}),
      },
      select: {
        id: true,
        nombre: true,
        usuario: true,
        estado: true,
        rol: {
          select: {
            id: true,
            codigo: true,
            nombre: true,
          },
        },
        departamentos: {
          where: {
            estado: "ACTIVO",
            departamento: {
              estado: "ACTIVO",
              eliminadoEn: null,
            },
          },
          select: {
            departamentoId: true,
            departamento: {
              select: {
                id: true,
                codigo: true,
                nombre: true,
              },
            },
          },
        },
      },
      orderBy: { nombre: "asc" },
    });

    return usuarios;
  }
}

export const inspeccionesService = new InspeccionesService();

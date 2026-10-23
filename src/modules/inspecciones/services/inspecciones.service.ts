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
  departamentoAuditoriaId?: number;
  horma?: string | null;
  notas?: string | null;
  detalles: ItemDefectoInput[];
  usuarioId: number;
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
  departamentoAuditoriaId?: number;
  inspectorId?: number;
  mes?: number;
  anio?: number;
  page: number;
  limit: number;
}

export class InspeccionesService {
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
   */
  async createInspeccion(params: CreateInspeccionParams) {
    const {
      lote: codigoLote,
      lineaId,
      departamentoAuditoriaId: deptoParam,
      horma: hormaParam,
      notas,
      detalles,
      usuarioId,
      terminal,
      reqInfo,
    } = params;

    const loteExistente = await prisma.produccionLote.findFirst({
      where: {
        lote: codigoLote.trim(),
        eliminadoEn: null,
      },
    });

    if (!loteExistente) {
      throw new NotFoundError(`El lote '${codigoLote}' no existe en el sistema de producción.`);
    }

    let deptoAuditoriaId: number;
    if (terminal) {
      deptoAuditoriaId = terminal.departamentoId;
    } else if (deptoParam) {
      deptoAuditoriaId = deptoParam;
    } else {
      const deptoUsuario = await prisma.usuarioDepartamento.findFirst({
        where: {
          usuarioId,
          estado: "ACTIVO",
          departamento: { estado: "ACTIVO" },
        },
        select: { departamentoId: true },
      });

      if (!deptoUsuario) {
        throw new BadRequestError(
          "No se pudo determinar el departamento auditor. Vincule una terminal operativa o especifique el departamento autorizado."
        );
      }
      deptoAuditoriaId = deptoUsuario.departamentoId;
    }

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

    return await prisma.$transaction(async (tx) => {
      const folio = await this.generateNextFolio(tx);

      const cabecera = await tx.inspeccionCabecera.create({
        data: {
          folio,
          loteId: loteExistente.id,
          inspectorId: usuarioId,
          departamentoAuditoriaId: deptoAuditoriaId,
          terminalId: terminal?.id || null,
          lineaId: lineaId || null,
          horma: hormaEfectiva,
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
  }

  /**
   * Consulta a nivel de cada defecto registrado (fila unitaria como en el sistema original).
   * Soporta periodos: 'hoy', 'ultimos' (30 registros) y 'todos' (con filtro por mes y año).
   * Búsqueda por Lote o Clave de Defecto.
   */
  async getFilasInspeccion(params: GetInspeccionesParams) {
    const where: Record<string, unknown> = {
      eliminadoEn: null,
      inspeccion: {
        eliminadoEn: null,
      },
    };

    // 1. Filtro por departamento auditor
    if (params.departamentoAuditoriaId) {
      (where.inspeccion as any).departamentoAuditoriaId = params.departamentoAuditoriaId;
    }

    if (params.inspectorId) {
      (where.inspeccion as any).inspectorId = params.inspectorId;
    }

    // 2. Filtro temporal según período
    const periodo = params.periodo || "ultimos";

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

      where.AND = [{ OR: orConditions }];
    }

    if (params.lote) {
      (where.inspeccion as any).lote = {
        lote: { contains: params.lote.trim() },
      };
    }

    if (params.defectoClave) {
      where.defecto = { clave: params.defectoClave };
    }

    // Límite según periodo: Si es 'ultimos', son 30 registros
    const take = periodo === "ultimos" ? 30 : params.limit;
    const skip = periodo === "ultimos" ? 0 : (params.page - 1) * take;

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
      linea: d.inspeccion.linea?.nombre || "L1",
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
    }));

    return {
      items,
      total,
      periodo,
      page: periodo === "ultimos" ? 1 : params.page,
      limit: take,
      totalPages: periodo === "ultimos" ? 1 : Math.ceil(total / take) || 1,
    };
  }
}

export const inspeccionesService = new InspeccionesService();

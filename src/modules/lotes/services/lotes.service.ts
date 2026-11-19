import { prisma } from "../../../config/database";
import { NotFoundError, BadRequestError, ConflictError } from "../../../utils/errors";
import type { ProduccionLote } from "@prisma/client";

export interface LoteCoincidenciaResumen {
  id: number;
  listaLote: string;
  lista: string;
  lote: string;
  idProducto: string;
  modelo: string;
  cantidad: number;
  descripcion: string | null;
  cliente: string;
  horma: string | null;
}

export class AmbiguousLoteError extends ConflictError {
  public readonly codigo = "AMBIGUOUS_LOTE";
  public readonly coincidencias: LoteCoincidenciaResumen[];

  constructor(lote: string, coincidencias: LoteCoincidenciaResumen[]) {
    const listasStr = coincidencias.map((c) => c.lista).join(", ");
    super(
      `El número de lote '${lote}' existe en ${coincidencias.length} listas activas diferentes (${listasStr}). Especifique el parámetro 'lista' para desambiguar.`
    );
    this.coincidencias = coincidencias;
    (this as any).errors = {
      codigo: "AMBIGUOUS_LOTE",
      lote,
      listasDisponibles: coincidencias.map((c) => c.lista),
      coincidencias,
    };
  }
}

export class LotesService {
  /**
   * Obtiene la información oficial de un lote activo.
   * Reglas de resolución obligatorias:
   * 1. Acepta el código de barras canónico '[L]listaLote' o 'listaLote'.
   * 2. Si se proporciona lista + lote, resuelve exactamente esa combinación.
   * 3. Si solo se proporciona el número de lote:
   *    - Si hay exactamente 1 lote activo, lo devuelve.
   *    - Si hay múltiples lotes activos con el mismo número en listas diferentes, informa AMBIGÜEDAD (AmbiguousLoteError)
   *      sin seleccionar arbitrariamente el más reciente.
   *    - Si el lote existe en la base de datos pero está INACTIVO, lo informa con error explícito.
   *    - Si no existe ningún registro, arroja NotFoundError.
   */
  async getByCodigoLote(codigoLote: string, lista?: string) {
    const normalizado = codigoLote.trim();
    if (!normalizado) {
      throw new BadRequestError("El código de lote es obligatorio");
    }

    // 1. Escaneo de código de barras canónico [L]listaLote o coincidencia directa con listaLote
    if (normalizado.startsWith("[L]") || normalizado.length > 10) {
      const lotePorListaLote = await prisma.produccionLote.findFirst({
        where: {
          OR: [
            { listaLote: normalizado },
            { listaLote: `[L]${normalizado.replace(/^\[L\]/i, "")}` },
            { listaLote: normalizado.replace(/^\[L\]/i, "") },
          ],
          eliminadoEn: null,
        },
      });

      if (lotePorListaLote) {
        if (lotePorListaLote.estado !== "ACTIVO" || Number(lotePorListaLote.cantidad) <= 0) {
          throw new BadRequestError(
            `El lote '${lotePorListaLote.listaLote}' (Lista: ${lotePorListaLote.lista}, Lote: ${lotePorListaLote.lote}) se encuentra INACTIVO en el catálogo de producción y no está disponible para captura.`
          );
        }
        return this.mapLoteResponse(lotePorListaLote);
      }
    }

    // 2. Consulta con Lista explícita proporcionada
    if (lista && lista.trim()) {
      const listaNorm = lista.trim();
      const loteExacto = await prisma.produccionLote.findFirst({
        where: {
          lote: normalizado,
          lista: listaNorm,
          eliminadoEn: null,
        },
      });

      if (!loteExacto) {
        throw new NotFoundError(
          `No se encontró el lote '${normalizado}' en la lista '${listaNorm}' en el catálogo de producción.`
        );
      }

      if (loteExacto.estado !== "ACTIVO" || Number(loteExacto.cantidad) <= 0) {
        throw new BadRequestError(
          `El lote '${normalizado}' de la lista '${listaNorm}' se encuentra INACTIVO en el catálogo y no está disponible para captura.`
        );
      }

      return this.mapLoteResponse(loteExacto);
    }

    // 3. Consulta únicamente por número de Lote
    const registros = await prisma.produccionLote.findMany({
      where: {
        OR: [
          { lote: normalizado },
          { listaLote: normalizado },
        ],
        eliminadoEn: null,
      },
      orderBy: { id: "desc" },
    });

    if (registros.length === 0) {
      throw new NotFoundError(
        `El lote '${normalizado}' no existe en el catálogo de producción.`
      );
    }

    const activos = registros.filter(
      (r) => r.estado === "ACTIVO" && Number(r.cantidad) > 0
    );

    // Si hay exactamente 1 lote activo
    if (activos.length === 1) {
      return this.mapLoteResponse(activos[0]);
    }

    // Si hay múltiples lotes activos con el mismo número en listas diferentes: AMBIGÜEDAD
    if (activos.length > 1) {
      const coincidencias: LoteCoincidenciaResumen[] = activos.map((a) => ({
        id: a.id,
        listaLote: a.listaLote,
        lista: a.lista,
        lote: a.lote,
        idProducto: a.idProducto,
        modelo: a.modelo,
        cantidad: Number(a.cantidad),
        descripcion: a.descripcion,
        cliente: a.cliente,
        horma: a.horma,
      }));

      throw new AmbiguousLoteError(normalizado, coincidencias);
    }

    // Si no hay ninguno activo, pero sí existen inactivos
    const inactivoEjemplo = registros[0];
    throw new BadRequestError(
      `El lote '${normalizado}' (Lista: ${inactivoEjemplo.lista}) se encuentra INACTIVO en el catálogo de producción y no está disponible para captura.`
    );
  }

  /**
   * Búsqueda paginada de lotes para autocompletado y consulta rápida.
   * Filtra por defecto lotes vigentes y activos.
   */
  async searchLotes(params: {
    busqueda?: string;
    lista?: string;
    modelo?: string;
    cliente?: string;
    incluirInactivos?: boolean;
    page: number;
    limit: number;
  }) {
    const where: Record<string, unknown> = {
      eliminadoEn: null,
    };

    if (!params.incluirInactivos) {
      where.estado = "ACTIVO";
      where.cantidad = { gt: 0 };
    }

    if (params.busqueda) {
      const q = params.busqueda.trim();
      where.OR = [
        { listaLote: { contains: q } },
        { lote: { contains: q } },
        { lista: { contains: q } },
        { modelo: { contains: q } },
        { cliente: { contains: q } },
        { descripcion: { contains: q } },
      ];
    }

    if (params.lista) {
      where.lista = { contains: params.lista.trim() };
    }

    if (params.modelo) {
      where.modelo = { contains: params.modelo.trim() };
    }

    if (params.cliente) {
      where.cliente = { contains: params.cliente.trim() };
    }

    const skip = (params.page - 1) * params.limit;

    const [items, total] = await Promise.all([
      prisma.produccionLote.findMany({
        where,
        skip,
        take: params.limit,
        orderBy: { id: "desc" },
      }),
      prisma.produccionLote.count({ where }),
    ]);

    return {
      items: items.map((lote: ProduccionLote) => this.mapLoteResponse(lote)),
      total,
      page: params.page,
      limit: params.limit,
      totalPages: Math.ceil(total / params.limit) || 1,
    };
  }

  private mapLoteResponse(lote: ProduccionLote) {
    return {
      id: lote.id,
      listaLote: lote.listaLote,
      lista: lote.lista,
      lote: lote.lote,
      idProducto: lote.idProducto,
      modelo: lote.modelo,
      cantidad: Number(lote.cantidad),
      descripcion: lote.descripcion,
      cliente: lote.cliente,
      horma: lote.horma,
      estado: lote.estado,
    };
  }
}

export const lotesService = new LotesService();

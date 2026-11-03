import { prisma } from "../../../config/database";
import { NotFoundError } from "../../../utils/errors";
import type { ProduccionLote } from "@prisma/client";

export class LotesService {
  /**
   * Obtiene la información oficial de un lote por su código único de lote.
   */
  async getByCodigoLote(codigoLote: string) {
    const normalizado = codigoLote.trim();
    const lote = await prisma.produccionLote.findFirst({
      where: {
        lote: normalizado,
        estado: "ACTIVO",
        cantidad: { gt: 0 },
        eliminadoEn: null,
      },
    });

    if (!lote) {
      throw new NotFoundError(`El lote '${normalizado}' no existe o no está disponible en la lista de producción.`);
    }

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

  /**
   * Búsqueda paginada de lotes para autocompletado y consulta rápida.
   */
  async searchLotes(params: {
    busqueda?: string;
    lista?: string;
    modelo?: string;
    cliente?: string;
    page: number;
    limit: number;
  }) {
    const where: Record<string, unknown> = {
      estado: "ACTIVO",
      cantidad: { gt: 0 },
      eliminadoEn: null,
    };

    if (params.busqueda) {
      const q = params.busqueda.trim();
      where.OR = [
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
      items: items.map((lote: ProduccionLote) => ({
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
      })),
      total,
      page: params.page,
      limit: params.limit,
      totalPages: Math.ceil(total / params.limit) || 1,
    };
  }
}

export const lotesService = new LotesService();

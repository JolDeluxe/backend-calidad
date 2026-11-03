import { prisma } from "../../../config/database";

export interface LotesCatalogoOfflineParams {
  desde?: Date;
  cursor?: number;
  limit?: number;
}

export interface LoteOfflineItem {
  id: number;
  lote: string;
  lista: string;
  idProducto: string;
  modelo: string;
  cantidad: number;
  horma: string | null;
  cliente: string;
  activo: boolean; // false si fue inactivado o eliminado lógicamente
  actualizadoEn: Date;
}

export class LotesCatalogoOfflineService {
  /**
   * Consulta paginada y determinista para descarga inicial o sincronización diferencial de lotes.
   * - Paginación keyset estable mediante ID para no omitir registros con timestamps idénticos.
   * - En sincronización diferencial (`desde`), incluye los lotes desactivados o eliminados lógicamente
   *   para que el cliente los purgue de IndexedDB.
   */
  async getCatalogoOffline(params: LotesCatalogoOfflineParams) {
    const limit = Math.min(params.limit || 500, 1000);
    const cursor = params.cursor || 0;
    // Capturar marca temporal del servidor ANTES de ejecutar la consulta para que cualquier
    // actualización concurrente durante la lectura de páginas sea incluida en la próxima corrida.
    const servidorTimestamp = new Date().toISOString();

    const where: any = {
      id: { gt: cursor },
    };

    if (params.desde) {
      // Sincronización diferencial: cambios a partir de la fecha (con margen de seguridad de 2s
      // para absorber diferencias de resolución en MySQL o transacciones en vuelo)
      const margenMs = 2000;
      const desdeConMargen = new Date(Math.max(0, params.desde.getTime() - margenMs));
      where.fechaActualizacion = { gte: desdeConMargen };
    } else {
      // Carga inicial (bootstrap): solo lotes activos, no eliminados y con pares válidos de producción
      where.estado = "ACTIVO";
      where.cantidad = { gt: 0 };
      where.eliminadoEn = null;
    }

    const registros = await prisma.produccionLote.findMany({
      where,
      select: {
        id: true,
        lote: true,
        lista: true,
        idProducto: true,
        modelo: true,
        cantidad: true,
        horma: true,
        cliente: true,
        estado: true,
        eliminadoEn: true,
        fechaActualizacion: true,
      },
      orderBy: { id: "asc" },
      take: limit + 1,
    });

    const hasMore = registros.length > limit;
    const items = hasMore ? registros.slice(0, limit) : registros;
    const nextCursor = items.length > 0 ? items[items.length - 1].id : null;

    const itemsNormalizados: LoteOfflineItem[] = items.map((l) => ({
      id: l.id,
      lote: l.lote,
      lista: l.lista,
      idProducto: l.idProducto,
      modelo: l.modelo,
      cantidad: Number(l.cantidad),
      horma: l.horma,
      cliente: l.cliente,
      activo: l.estado === "ACTIVO" && Number(l.cantidad) > 0 && l.eliminadoEn === null,
      actualizadoEn: l.fechaActualizacion,
    }));

    return {
      items: itemsNormalizados,
      hasMore,
      nextCursor,
      totalLote: itemsNormalizados.length,
      servidorTimestamp,
    };
  }
}

export const lotesCatalogoOfflineService = new LotesCatalogoOfflineService();

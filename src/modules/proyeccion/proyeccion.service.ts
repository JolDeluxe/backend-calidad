import { prisma } from "../../config/database";
import {
  getIsoYearAndWeek,
  getPartesFechaMexico,
  getRangoSemanaIsoUtc,
} from "../../utils/timezone";

export interface ResumenDeptoProyeccion {
  id: number;
  codigo: string;
  nombre: string;
  paresDefecto: number;
  produccionLograda: number;
  porcentajeDefecto: number;
}

export interface ResumenGeneralProyeccionResponse {
  semana: number;
  anio: number;
  fechaDesde: string;
  fechaHasta: string;
  fechaActualizacion: string;
  totales: {
    paresDefecto: number;
    produccionLograda: number;
    porcentajeDefecto: number;
  };
  departamentos: ResumenDeptoProyeccion[];
}

export interface TopDefectoItem {
  clave: number;
  defecto: string;
  clasificacion: string;
  totalPares: number;
}

export interface TopDefectoApiladoItem {
  clave: number;
  defecto: string;
  totalPares: number;
  desglosePorArea: Record<string, number>;
}

export interface ReporteDeptoItem {
  departamentoId: number;
  codigo: string;
  nombre: string;
  kpis: {
    semana: number;
    anio: number;
    defectosTotales: number;
    produccionLograda: number;
    indiceDefectosPct: number;
  };
  desgloseCaptura: Array<{
    departamentoAuditorId: number;
    departamentoAuditor: string;
    cantidad: number;
    porcentaje: number;
  }>;
  eficienciaInspector: {
    defectosEnOtrasAreas: number;
    devoluciones: number;
    porcentajeEficiencia: number;
  };
  topDefectos: TopDefectoItem[];
  topDefectosApilados: TopDefectoApiladoItem[];
}

export interface ReporteSemanalProyeccionResponse {
  semana: number;
  anio: number;
  fechaDesde: string;
  fechaHasta: string;
  departamentos: ReporteDeptoItem[];
}

export class ProyeccionService {
  /**
   * Obtiene el rango de fechas de la semana operativa de Calidad (Miércoles 00:00:00 a Martes 23:59:59.999)
   */
  private getRangoSemana(semanaNum?: number, anioNum?: number): {
    desde: Date;
    hasta: Date;
    semana: number;
    anio: number;
  } {
    const partesHoy = getPartesFechaMexico();
    const isoHoy = getIsoYearAndWeek(partesHoy.fechaStr);
    const anio = anioNum || isoHoy.anioIso;
    const semana = semanaNum || isoHoy.semanaIso;
    const { inicioUtc, finUtc } = getRangoSemanaIsoUtc(anio, semana);
    return {
      desde: inicioUtc,
      hasta: new Date(finUtc.getTime() - 1),
      semana,
      anio,
    };
  }

  /**
   * Resumen General de Planta (Vista 1)
   */
  async getResumenGeneral(semanaNum?: number, anioNum?: number): Promise<ResumenGeneralProyeccionResponse> {
    const { desde, hasta, semana, anio } = this.getRangoSemana(semanaNum, anioNum);

    // 1. Departamentos operativos activos (Corte, Preliminares, Bordado & Láser, Pespunte, Montado, Avíos, Acabado, etc.)
    const departamentos = await prisma.departamento.findMany({
      where: {
        estado: "ACTIVO",
        eliminadoEn: null,
      },
      select: {
        id: true,
        codigo: true,
        nombre: true,
      },
      orderBy: { id: "asc" },
    });

    // 2. Defectos agrupados por departamento responsable (defDeptoId) en la semana
    const defectosPorDepto = await prisma.inspeccionDetalle.groupBy({
      by: ["defDeptoId"],
      where: {
        eliminadoEn: null,
        inspeccion: {
          eliminadoEn: null,
          fechaInspeccion: { gte: desde, lte: hasta },
        },
      },
      _sum: {
        paresDefectuosos: true,
      },
    });

    const mapaDefectos = new Map<number, number>();
    for (const d of defectosPorDepto) {
      mapaDefectos.set(d.defDeptoId, d._sum.paresDefectuosos || 0);
    }

    // 3. Producción lograda por departamento auditor en la semana:
    // Suma de los pares de lotes únicos inspeccionados en ese departamento en la semana
    const inspeccionesConLote = await prisma.inspeccionCabecera.findMany({
      where: {
        eliminadoEn: null,
        fechaInspeccion: { gte: desde, lte: hasta },
      },
      select: {
        departamentoAuditoriaId: true,
        loteId: true,
        lote: {
          select: {
            cantidad: true,
          },
        },
      },
    });

    // Agrupar lotes por departamento auditor para sumar su cantidad una sola vez por lote
    const mapaProduccion = new Map<number, number>();
    const lotesVistosPorDepto = new Map<number, Set<number>>();

    for (const insp of inspeccionesConLote) {
      const deptoId = insp.departamentoAuditoriaId;
      const loteId = insp.loteId;
      const cant = Number(insp.lote?.cantidad) || 0;

      if (!lotesVistosPorDepto.has(deptoId)) {
        lotesVistosPorDepto.set(deptoId, new Set<number>());
      }
      const setLotes = lotesVistosPorDepto.get(deptoId)!;
      if (!setLotes.has(loteId)) {
        setLotes.add(loteId);
        mapaProduccion.set(deptoId, (mapaProduccion.get(deptoId) || 0) + cant);
      }
    }

    // 4. Mapear resultados por departamento
    let totalParesDefecto = 0;
    let totalProduccion = 0;

    const listaDeptos: ResumenDeptoProyeccion[] = departamentos.map((d) => {
      const paresDef = mapaDefectos.get(d.id) || 0;
      const prod = mapaProduccion.get(d.id) || 0;
      const pct = prod > 0 ? Number(((paresDef / prod) * 100).toFixed(2)) : 0;

      totalParesDefecto += paresDef;
      totalProduccion += prod;

      return {
        id: d.id,
        codigo: d.codigo,
        nombre: d.nombre,
        paresDefecto: paresDef,
        produccionLograda: prod,
        porcentajeDefecto: pct,
      };
    });

    const porcentajeGlobal =
      totalProduccion > 0 ? Number(((totalParesDefecto / totalProduccion) * 100).toFixed(2)) : 0;

    return {
      semana,
      anio,
      fechaDesde: desde.toISOString(),
      fechaHasta: hasta.toISOString(),
      fechaActualizacion: new Date().toISOString(),
      totales: {
        paresDefecto: totalParesDefecto,
        produccionLograda: totalProduccion,
        porcentajeDefecto: porcentajeGlobal,
      },
      departamentos: listaDeptos,
    };
  }

  /**
   * Reporte Semanal Completo por Departamento (Vista 2 - Kiosco / TV)
   */
  async getReporteSemanal(semanaNum?: number, anioNum?: number): Promise<ReporteSemanalProyeccionResponse> {
    const { desde, hasta, semana, anio } = this.getRangoSemana(semanaNum, anioNum);

    // 1. Departamentos activos
    const departamentos = await prisma.departamento.findMany({
      where: {
        estado: "ACTIVO",
        eliminadoEn: null,
      },
      select: {
        id: true,
        codigo: true,
        nombre: true,
      },
      orderBy: { id: "asc" },
    });

    const mapaNombreDeptos = new Map<number, string>(departamentos.map((d) => [d.id, d.nombre]));

    // 2. Todos los detalles de inspección de la semana
    const detallesSemana = await prisma.inspeccionDetalle.findMany({
      where: {
        eliminadoEn: null,
        inspeccion: {
          eliminadoEn: null,
          fechaInspeccion: { gte: desde, lte: hasta },
        },
      },
      select: {
        id: true,
        defDeptoId: true,
        defectoId: true,
        paresDefectuosos: true,
        defecto: {
          select: {
            clave: true,
            defecto: true,
            clasificacion: true,
          },
        },
        inspeccion: {
          select: {
            departamentoAuditoriaId: true,
          },
        },
      },
    });

    // 3. Inspecciones con lotes para calcular producción lograda por departamento
    const inspeccionesLotes = await prisma.inspeccionCabecera.findMany({
      where: {
        eliminadoEn: null,
        fechaInspeccion: { gte: desde, lte: hasta },
      },
      select: {
        departamentoAuditoriaId: true,
        loteId: true,
        lote: {
          select: {
            cantidad: true,
          },
        },
      },
    });

    const lotesPorDepto = new Map<number, Set<number>>();
    const mapaProduccion = new Map<number, number>();

    for (const insp of inspeccionesLotes) {
      const deptoId = insp.departamentoAuditoriaId;
      const loteId = insp.loteId;
      const cant = Number(insp.lote?.cantidad) || 0;

      if (!lotesPorDepto.has(deptoId)) {
        lotesPorDepto.set(deptoId, new Set<number>());
      }
      const setLotes = lotesPorDepto.get(deptoId)!;
      if (!setLotes.has(loteId)) {
        setLotes.add(loteId);
        mapaProduccion.set(deptoId, (mapaProduccion.get(deptoId) || 0) + cant);
      }
    }

    // 4. Construir el reporte para cada departamento
    const reportesDeptos: ReporteDeptoItem[] = departamentos.map((depto) => {
      // Filtrar defectos imputados a este departamento
      const detallesDeEsteDepto = detallesSemana.filter((d) => d.defDeptoId === depto.id);

      const defectosTotales = detallesDeEsteDepto.reduce((acc, d) => acc + d.paresDefectuosos, 0);
      const produccionLograda = mapaProduccion.get(depto.id) || 0;
      const indiceDefectosPct =
        produccionLograda > 0 ? Number(((defectosTotales / produccionLograda) * 100).toFixed(2)) : 0;

      // Desglose de en qué departamentos se detectaron los defectos de este departamento
      const desglosePorAuditor = new Map<number, number>();
      let defectosEnOtrasAreas = 0;

      for (const item of detallesDeEsteDepto) {
        const audId = item.inspeccion.departamentoAuditoriaId;
        desglosePorAuditor.set(audId, (desglosePorAuditor.get(audId) || 0) + item.paresDefectuosos);

        if (audId !== depto.id) {
          defectosEnOtrasAreas += item.paresDefectuosos;
        }
      }

      const listaDesglose = Array.from(desglosePorAuditor.entries()).map(([audId, cant]) => {
        const pct = defectosTotales > 0 ? Number(((cant / defectosTotales) * 100).toFixed(1)) : 0;
        return {
          departamentoAuditorId: audId,
          departamentoAuditor: mapaNombreDeptos.get(audId) || `Depto ${audId}`,
          cantidad: cant,
          porcentaje: pct,
        };
      }).sort((a, b) => b.cantidad - a.cantidad);

      // Eficiencia del Inspector oficial de planta
      const devoluciones = 0; // Campo base ampliable
      let porcentajeEficiencia = 100;
      if (produccionLograda > 0) {
        const tasaFallo = (defectosEnOtrasAreas + devoluciones) / produccionLograda;
        porcentajeEficiencia = Number(Math.max(0, (1 - tasaFallo) * 100).toFixed(2));
      }

      // Top 10 Defectos del departamento
      const rankingDefectos = new Map<number, { clave: number; defecto: string; clasificacion: string; totalPares: number }>();
      const desgloseApilado = new Map<number, { clave: number; defecto: string; totalPares: number; desglosePorArea: Record<string, number> }>();

      for (const item of detallesDeEsteDepto) {
        const c = item.defecto.clave;
        const nombreDef = item.defecto.defecto;
        const clasif = item.defecto.clasificacion;
        const pares = item.paresDefectuosos;
        const audNombre = mapaNombreDeptos.get(item.inspeccion.departamentoAuditoriaId) || "Otra Área";

        // Top simple
        if (!rankingDefectos.has(c)) {
          rankingDefectos.set(c, { clave: c, defecto: nombreDef, clasificacion: clasif, totalPares: 0 });
        }
        rankingDefectos.get(c)!.totalPares += pares;

        // Top apilado por área auditora
        if (!desgloseApilado.has(c)) {
          desgloseApilado.set(c, { clave: c, defecto: nombreDef, totalPares: 0, desglosePorArea: {} });
        }
        const ap = desgloseApilado.get(c)!;
        ap.totalPares += pares;
        ap.desglosePorArea[audNombre] = (ap.desglosePorArea[audNombre] || 0) + pares;
      }

      const topDefectos = Array.from(rankingDefectos.values())
        .sort((a, b) => b.totalPares - a.totalPares)
        .slice(0, 10);

      const topDefectosApilados = Array.from(desgloseApilado.values())
        .sort((a, b) => b.totalPares - a.totalPares)
        .slice(0, 8);

      return {
        departamentoId: depto.id,
        codigo: depto.codigo,
        nombre: depto.nombre,
        kpis: {
          semana,
          anio,
          defectosTotales,
          produccionLograda,
          indiceDefectosPct,
        },
        desgloseCaptura: listaDesglose,
        eficienciaInspector: {
          defectosEnOtrasAreas,
          devoluciones,
          porcentajeEficiencia,
        },
        topDefectos,
        topDefectosApilados,
      };
    });

    return {
      semana,
      anio,
      fechaDesde: desde.toISOString(),
      fechaHasta: hasta.toISOString(),
      departamentos: reportesDeptos,
    };
  }
}

export const proyeccionService = new ProyeccionService();

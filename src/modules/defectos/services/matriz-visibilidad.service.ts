import { prisma } from "../../../config/database";
import type { Prisma, DepartamentoVisibilidadDefecto } from "@prisma/client";

export interface ResolucionVisibilidad {
  permitido: boolean;
  origenRegla: "EXCEPCION" | "MATRIZ" | "DEFAULT_COMPATIBILIDAD";
  departamentoPropietarioId: number;
  departamentoDeteccionId: number;
  defectoId?: number;
}

export class MatrizVisibilidadDefectosService {
  /**
   * Resuelve si un defecto es detectable en un departamento de detección dado.
   * Orden de prioridad obligatorio:
   * 1. Excepción explícita individual en `DefectoEtapa` (si existe para ese defecto y departamento).
   * 2. Regla en la matriz maestra `DepartamentoVisibilidadDefecto` entre departamentoOrigen y departamentoDestino.
   * 3. Regla por defecto de compatibilidad (ej. si es su propio departamento o si no está configurada la matriz).
   */
  async resolverVisibilidad(
    defectoId: number,
    departamentoDeteccionId: number
  ): Promise<ResolucionVisibilidad> {
    const defecto = await prisma.defecto.findUnique({
      where: { id: defectoId },
      select: {
        id: true,
        departamentoId: true,
        etapas: {
          where: { departamentoId: departamentoDeteccionId },
          select: { permitido: true },
        },
      },
    });

    if (!defecto) {
      return {
        permitido: false,
        origenRegla: "DEFAULT_COMPATIBILIDAD",
        departamentoPropietarioId: 0,
        departamentoDeteccionId,
        defectoId,
      };
    }

    return this.resolverVisibilidadConEntidades(
      defecto.departamentoId,
      departamentoDeteccionId,
      defecto.etapas[0]?.permitido,
      defecto.id
    );
  }

  /**
   * Variante optimizada cuando ya se tienen los datos en memoria o en lote.
   */
  async resolverVisibilidadConEntidades(
    departamentoPropietarioId: number,
    departamentoDeteccionId: number,
    excepcionPermitido?: boolean | null,
    defectoId?: number
  ): Promise<ResolucionVisibilidad> {
    // 1. Si existe una excepción individual explícita, utilizarla
    if (typeof excepcionPermitido === "boolean") {
      return {
        permitido: excepcionPermitido,
        origenRegla: "EXCEPCION",
        departamentoPropietarioId,
        departamentoDeteccionId,
        defectoId,
      };
    }

    // 2. Si no existe excepción, consultar la matriz maestra del departamento propietario
    const reglaMatriz = await prisma.departamentoVisibilidadDefecto.findUnique({
      where: {
        unique_depto_origen_destino: {
          departamentoOrigenId: departamentoPropietarioId,
          departamentoDestinoId: departamentoDeteccionId,
        },
      },
      select: { permitido: true },
    });

    if (reglaMatriz) {
      return {
        permitido: reglaMatriz.permitido,
        origenRegla: "MATRIZ",
        departamentoPropietarioId,
        departamentoDeteccionId,
        defectoId,
      };
    }

    // 3. Fallback de compatibilidad:
    // Si es el departamento propietario, siempre se permite. Si no hay matriz configurada, false por seguridad estricta.
    const permitidoCompat = departamentoPropietarioId === departamentoDeteccionId;
    return {
      permitido: permitidoCompat,
      origenRegla: "DEFAULT_COMPATIBILIDAD",
      departamentoPropietarioId,
      departamentoDeteccionId,
      defectoId,
    };
  }

  /**
   * Obtiene la matriz completa organizada por departamentos origen y destino.
   */
  async getMatrizCompleta() {
    const [deptos, reglas] = await Promise.all([
      prisma.departamento.findMany({
        where: { estado: "ACTIVO", eliminadoEn: null },
        select: { id: true, codigo: true, nombre: true, numeroLineas: true },
        orderBy: { id: "asc" },
      }),
      prisma.departamentoVisibilidadDefecto.findMany({
        include: {
          departamentoOrigen: { select: { id: true, codigo: true, nombre: true } },
          departamentoDestino: { select: { id: true, codigo: true, nombre: true } },
        },
      }),
    ]);

    // Contar cuántos defectos activos pertenecen a cada departamento origen
    const conteoDefectosPorDepto = await prisma.defecto.groupBy({
      by: ["departamentoId"],
      where: { eliminadoEn: null },
      _count: { id: true },
    });
    const mapaConteoDefectos = new Map<number, number>(
      conteoDefectosPorDepto.map((c: { departamentoId: number; _count: { id: number } }) => [c.departamentoId, c._count.id])
    );

    // Mapear reglas por clave "origenId-destinoId"
    const mapaReglas = new Map<string, DepartamentoVisibilidadDefecto>(
      reglas.map((r: DepartamentoVisibilidadDefecto) => [`${r.departamentoOrigenId}-${r.departamentoDestinoId}`, r])
    );

    const matricesPorOrigen = deptos.map((origen: { id: number; codigo: string; nombre: string; numeroLineas: number }) => {
      const destinos = deptos.map((destino: { id: number; codigo: string; nombre: string; numeroLineas: number }) => {
        const regla = mapaReglas.get(`${origen.id}-${destino.id}`);
        return {
          departamentoDestinoId: destino.id,
          departamentoDestinoCodigo: destino.codigo,
          departamentoDestinoNombre: destino.nombre,
          permitido: regla ? regla.permitido : origen.id === destino.id,
          configurado: !!regla,
          reglaId: regla ? regla.id : null,
          fechaActualizacion: regla ? regla.fechaActualizacion : null,
          actualizadoPor: regla ? regla.actualizadoPor : null,
        };
      });

      const configuradasCount = destinos.filter((d: { configurado: boolean }) => d.configurado).length;
      const estaConfigurado = configuradasCount === deptos.length;

      return {
        departamentoOrigenId: origen.id,
        departamentoOrigenCodigo: origen.codigo,
        departamentoOrigenNombre: origen.nombre,
        totalDefectosAfectados: mapaConteoDefectos.get(origen.id) || 0,
        estaConfigurado,
        configuradasCount,
        totalDestinos: deptos.length,
        destinos,
      };
    });

    return {
      departamentos: deptos,
      matrices: matricesPorOrigen,
    };
  }

  /**
   * Obtiene la matriz de visibilidad de un departamento origen específico.
   */
  async getMatrizPorDepartamento(departamentoOrigenId: number) {
    const deptoOrigen = await prisma.departamento.findUnique({
      where: { id: departamentoOrigenId, estado: "ACTIVO", eliminadoEn: null },
      select: { id: true, codigo: true, nombre: true },
    });

    if (!deptoOrigen) {
      throw new Error("El departamento de origen no existe o está inactivo");
    }

    const [deptos, reglas, conteoDefectos] = await Promise.all([
      prisma.departamento.findMany({
        where: { estado: "ACTIVO", eliminadoEn: null },
        select: { id: true, codigo: true, nombre: true },
        orderBy: { id: "asc" },
      }),
      prisma.departamentoVisibilidadDefecto.findMany({
        where: { departamentoOrigenId },
      }),
      prisma.defecto.count({
        where: { departamentoId: departamentoOrigenId, eliminadoEn: null },
      }),
    ]);

    const mapaReglas = new Map<number, DepartamentoVisibilidadDefecto>(
      reglas.map((r: DepartamentoVisibilidadDefecto) => [r.departamentoDestinoId, r])
    );

    const destinos = deptos.map((destino: { id: number; codigo: string; nombre: string }) => {
      const regla = mapaReglas.get(destino.id);
      return {
        departamentoDestinoId: destino.id,
        departamentoDestinoCodigo: destino.codigo,
        departamentoDestinoNombre: destino.nombre,
        permitido: regla ? regla.permitido : deptoOrigen.id === destino.id,
        configurado: !!regla,
        reglaId: regla ? regla.id : null,
        fechaActualizacion: regla ? regla.fechaActualizacion : null,
        actualizadoPor: regla ? regla.actualizadoPor : null,
      };
    });

    return {
      departamentoOrigen: deptoOrigen,
      totalDefectosAfectados: conteoDefectos,
      destinos,
    };
  }

  /**
   * Actualiza o crea una regla individual en la matriz maestra.
   */
  async upsertRegla(
    departamentoOrigenId: number,
    departamentoDestinoId: number,
    permitido: boolean,
    usuarioId: number
  ) {
    const [origen, destino] = await Promise.all([
      prisma.departamento.findUnique({
        where: { id: departamentoOrigenId, estado: "ACTIVO", eliminadoEn: null },
        select: { id: true, codigo: true, nombre: true },
      }),
      prisma.departamento.findUnique({
        where: { id: departamentoDestinoId, estado: "ACTIVO", eliminadoEn: null },
        select: { id: true, codigo: true, nombre: true },
      }),
    ]);

    if (!origen) throw new Error("Departamento de origen inexistente o inactivo");
    if (!destino) throw new Error("Departamento de destino inexistente o inactivo");

    const reglaAnterior = await prisma.departamentoVisibilidadDefecto.findUnique({
      where: {
        unique_depto_origen_destino: { departamentoOrigenId, departamentoDestinoId },
      },
    });

    const regla = await prisma.departamentoVisibilidadDefecto.upsert({
      where: {
        unique_depto_origen_destino: { departamentoOrigenId, departamentoDestinoId },
      },
      create: {
        departamentoOrigenId,
        departamentoDestinoId,
        permitido,
        creadoPor: usuarioId,
        actualizadoPor: usuarioId,
      },
      update: {
        permitido,
        actualizadoPor: usuarioId,
      },
    });

    return {
      regla,
      anterior: reglaAnterior,
      origen,
      destino,
    };
  }

  /**
   * Actualiza una matriz completa para un departamento origen.
   */
  async actualizarMatrizDepartamento(
    departamentoOrigenId: number,
    destinos: Array<{ departamentoDestinoId: number; permitido: boolean }>,
    usuarioId: number
  ) {
    const origen = await prisma.departamento.findUnique({
      where: { id: departamentoOrigenId, estado: "ACTIVO", eliminadoEn: null },
      select: { id: true, codigo: true, nombre: true },
    });
    if (!origen) throw new Error("Departamento de origen inexistente o inactivo");

    const destinosIds = destinos.map((d) => d.departamentoDestinoId);
    const destinosDb = await prisma.departamento.findMany({
      where: { id: { in: destinosIds }, estado: "ACTIVO", eliminadoEn: null },
      select: { id: true },
    });

    if (destinosDb.length !== destinosIds.length) {
      throw new Error("Uno o más departamentos destino son inválidos o están inactivos");
    }

    return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const resultados = [];
      for (const item of destinos) {
        const r = await tx.departamentoVisibilidadDefecto.upsert({
          where: {
            unique_depto_origen_destino: {
              departamentoOrigenId,
              departamentoDestinoId: item.departamentoDestinoId,
            },
          },
          create: {
            departamentoOrigenId,
            departamentoDestinoId: item.departamentoDestinoId,
            permitido: item.permitido,
            creadoPor: usuarioId,
            actualizadoPor: usuarioId,
          },
          update: {
            permitido: item.permitido,
            actualizadoPor: usuarioId,
          },
        });
        resultados.push(r);
      }
      return resultados;
    });
  }

  /**
   * Construye la condición WHERE de Prisma para filtrar defectos detectables en un departamento determinado (`departamentoDeteccionId`).
   * Cumple con la jerarquía de visibilidad:
   * 1. Excepción individual en `DefectoEtapa` para ese departamento con `permitido: true`.
   * 2. Si no tiene excepción individual para ese departamento:
   *    - Si el departamento propietario tiene una regla matriz hacia el departamento de detección con `permitido: true`.
   *    - O si no hay regla matriz para su departamento propietario y coincide con su propio departamento (compatibilidad por defecto).
   * 3. Excluye cualquier defecto que tenga excepción individual con `permitido: false`.
   */
  async construirWhereFiltroDefectosPorDepartamentoDeteccion(
    departamentoDeteccionId: number
  ): Promise<Prisma.DefectoWhereInput> {
    // 1. Obtener todas las reglas maestras que apuntan a este departamento de detección
    const reglas = await prisma.departamentoVisibilidadDefecto.findMany({
      where: { departamentoDestinoId: departamentoDeteccionId },
      select: { departamentoOrigenId: true, permitido: true },
    });

    const origenesPermitidosPorMatriz: number[] = [];
    const origenesBloqueadosPorMatriz: number[] = [];

    for (const r of reglas) {
      if (r.permitido) {
        origenesPermitidosPorMatriz.push(r.departamentoOrigenId);
      } else {
        origenesBloqueadosPorMatriz.push(r.departamentoOrigenId);
      }
    }

    // Propietarios que tienen regla explícita hacia este destino
    const todosOrigenesConRegla = new Set([
      ...origenesPermitidosPorMatriz,
      ...origenesBloqueadosPorMatriz,
    ]);

    // Si es su propio departamento y NO tiene regla en matriz, compatibilidad permite su propio departamento
    const compatibilidadPropio = !todosOrigenesConRegla.has(departamentoDeteccionId);

    const condicionesHerencia: Prisma.DefectoWhereInput[] = [];

    if (origenesPermitidosPorMatriz.length > 0) {
      condicionesHerencia.push({
        departamentoId: { in: origenesPermitidosPorMatriz },
      });
    }

    if (compatibilidadPropio) {
      condicionesHerencia.push({
        departamentoId: departamentoDeteccionId,
      });
    }

    return {
      AND: [
        // Nunca debe tener una excepción individual explícita en false para este departamento
        {
          etapas: {
            none: {
              departamentoId: departamentoDeteccionId,
              permitido: false,
            },
          },
        },
        // Y debe cumplirse una de dos vías:
        {
          OR: [
            // Vía A: Excepción individual explícita en true
            {
              etapas: {
                some: {
                  departamentoId: departamentoDeteccionId,
                  permitido: true,
                },
              },
            },
            // Vía B: Sin excepción individual para este departamento Y con herencia válida (matriz o compatibilidad)
            {
              AND: [
                {
                  etapas: {
                    none: {
                      departamentoId: departamentoDeteccionId,
                    },
                  },
                },
                condicionesHerencia.length > 0
                  ? { OR: condicionesHerencia }
                  : { id: -1 }, // Si ningún propietario puede heredar a este destino
              ],
            },
          ],
        },
      ],
    };
  }

  /**
   * Obtiene la plantilla de etapas permitidas por la matriz para un departamento propietario.
   * Utilizada al dar de alta nuevos defectos para asociar su matriz inicial respetando las reglas maestras.
   */
  async obtenerPlantillaEtapasParaPropietario(
    departamentoPropietarioId: number
  ): Promise<Map<number, boolean>> {
    const reglas = await prisma.departamentoVisibilidadDefecto.findMany({
      where: { departamentoOrigenId: departamentoPropietarioId },
      select: { departamentoDestinoId: true, permitido: true },
    });

    const mapa = new Map<number, boolean>();
    reglas.forEach((r: { departamentoDestinoId: number; permitido: boolean }) => mapa.set(r.departamentoDestinoId, r.permitido));
    return mapa;
  }
}

export const matrizVisibilidadDefectosService = new MatrizVisibilidadDefectosService();

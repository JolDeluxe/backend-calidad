import { prisma } from "../../../config/database";
import { BadRequestError, ConflictError } from "../../../utils/errors";
import { auditService } from "../../audit/services/audit.service";
import type { Prisma } from "@prisma/client";
import { matrizVisibilidadDefectosService } from "./matriz-visibilidad.service";
import {
  CONSECUTIVO_MAX,
  CONSECUTIVO_AGOTADO,
  MAX_FILAS_LOTE,
  proyectarClaves,
  rangoDeGrupo,
  validarFilasLote,
  type FilaLoteEntrada,
} from "../codificacion-claves";

type ClasificacionDefecto = "CRITICO" | "MAYOR" | "MENOR";

export interface LoteDefectosInput {
  lineaId: number;
  departamentoId: number;
  filas: Array<{ clave?: number; descripcion: string; clasificacion: string }>;
  departamentosIds?: number[];
  etapasPermitidasIds?: number[];
}

interface GrupoResuelto {
  id: number;
  lineaId: number;
  departamentoId: number;
  prefijo: number;
  siguienteConsecutivo: number;
  activo: boolean;
}

type DbClient = Prisma.TransactionClient | typeof prisma;

const toNumber = (v: unknown): number => Number(v);

/**
 * Codificación de claves de defecto por grupo (línea + departamento propietario).
 *
 * Concurrencia: la asignación definitiva ocurre dentro de una transacción que bloquea la fila del grupo
 * (`SELECT ... FOR UPDATE`) y lee las claves ocupadas con lectura bloqueante (ve el último dato confirmado,
 * incluso con REPEATABLE READ). La restricción única de `defectos.clave` es la última barrera.
 * La previsualización nunca escribe ni bloquea.
 */
export class CodificacionDefectosService {
  /** Resuelve el grupo de codificación aplicable de forma explícita; nunca elige una línea arbitraria. */
  async resolverGrupo(
    lineaId: number | undefined,
    departamentoId: number,
    db: DbClient = prisma,
  ): Promise<GrupoResuelto> {
    if (lineaId !== undefined) {
      const linea = await db.linea.findFirst({
        where: { id: lineaId, estado: "ACTIVO", eliminadoEn: null },
        select: { id: true, nombre: true },
      });
      if (!linea) {
        throw new BadRequestError("La línea especificada no existe o está inactiva");
      }

      const asignacion = await db.departamentoLinea.findFirst({
        where: { lineaId, departamentoId, activo: true, eliminadoEn: null },
        select: { id: true },
      });
      if (!asignacion) {
        throw new BadRequestError(
          `El departamento seleccionado no está asignado a la línea ${linea.nombre}`,
        );
      }

      const grupo = await db.grupoCodificacionDefecto.findUnique({
        where: { unique_grupo_linea_depto: { lineaId, departamentoId } },
      });
      if (!grupo) {
        throw new BadRequestError(
          `Grupo de codificación pendiente de configuración para la línea ${linea.nombre} y el departamento seleccionado`,
        );
      }
      if (!grupo.activo) {
        throw new BadRequestError("El grupo de codificación de esta línea y departamento está inactivo");
      }
      return grupo;
    }

    const grupos = await db.grupoCodificacionDefecto.findMany({
      where: { departamentoId, activo: true },
    });
    if (grupos.length === 0) {
      throw new BadRequestError(
        "El departamento propietario no tiene un grupo de codificación configurado (pendiente de configuración)",
      );
    }
    if (grupos.length > 1) {
      throw new BadRequestError(
        "El departamento propietario pertenece a varios grupos de codificación; especifique la línea de referencia (lineaId)",
      );
    }
    return grupos[0];
  }

  async getGrupos(lineaId?: number) {
    const grupos = await prisma.grupoCodificacionDefecto.findMany({
      where: lineaId ? { lineaId } : {},
      include: {
        linea: { select: { id: true, codigo: true, nombre: true } },
        departamento: { select: { id: true, codigo: true, nombre: true } },
      },
      orderBy: [{ lineaId: "asc" }, { prefijo: "asc" }],
    });

    return grupos.map((g) => ({
      id: g.id,
      lineaId: g.lineaId,
      departamentoId: g.departamentoId,
      prefijo: g.prefijo,
      siguienteConsecutivo: g.siguienteConsecutivo,
      activo: g.activo,
      agotado: g.siguienteConsecutivo >= CONSECUTIVO_AGOTADO,
      linea: g.linea,
      departamento: g.departamento,
    }));
  }

  private async leerClavesOcupadas(db: DbClient, prefijo: number): Promise<Set<number>> {
    const { min, max } = rangoDeGrupo(prefijo);
    // Incluye defectos eliminados lógicamente: sus claves nunca se reutilizan.
    const rows = await db.defecto.findMany({
      where: { clave: { gte: min, lte: max } },
      select: { clave: true },
    });
    return new Set(rows.map((r) => r.clave));
  }

  /** Previsualiza las claves propuestas. No reserva ni consume consecutivos. */
  async previsualizarLote(input: LoteDefectosInput) {
    if (input.filas.length > MAX_FILAS_LOTE) {
      throw new BadRequestError(`El lote no puede exceder ${MAX_FILAS_LOTE} filas`);
    }

    await this.validarDepartamento(input.departamentoId);

    const validaciones = validarFilasLote(input.filas as FilaLoteEntrada[]);
    const todasConClaveManual = input.filas.length > 0 && input.filas.every((f) => f.clave !== undefined && f.clave > 0);

    if (todasConClaveManual) {
      // Modo manual: comprobar si alguna de las claves ya existe en la base de datos
      const clavesManuales = input.filas.map((f) => f.clave as number);
      const existentes = await prisma.defecto.findMany({
        where: { clave: { in: clavesManuales } },
        select: { clave: true, defecto: true },
      });
      const mapaExistentes = new Map(existentes.map((e) => [e.clave, e.defecto]));

      const filas = validaciones.map((v) => {
        const filaEntrada = input.filas[v.indice];
        const clave = filaEntrada?.clave ?? null;
        const errores = [...v.errores];
        if (clave && mapaExistentes.has(clave)) {
          errores.push(`La clave #${clave} ya está ocupada ('${mapaExistentes.get(clave)}')`);
        }
        return {
          indice: v.indice,
          valida: errores.length === 0,
          errores,
          clavePropuesta: clave,
        };
      });

      const todasValidas = filas.every((f) => f.valida);
      return {
        grupo: null,
        filas,
        clavesOmitidas: [],
        errores: [],
        valido: todasValidas && filas.length > 0,
      };
    }

    // Modo automático por grupo
    const grupo = await this.resolverGrupo(input.lineaId, input.departamentoId);
    const ocupadas = await this.leerClavesOcupadas(prisma, grupo.prefijo);
    const validas = validaciones.filter((v) => v.errores.length === 0);

    const proyeccion = proyectarClaves(
      grupo.prefijo,
      grupo.siguienteConsecutivo,
      validas.length,
      ocupadas,
    );
    const disponibles = proyectarClaves(
      grupo.prefijo,
      grupo.siguienteConsecutivo,
      CONSECUTIVO_MAX,
      ocupadas,
    ).claves.length;

    let cursor = 0;
    const filas = validaciones.map((v) => {
      const valida = v.errores.length === 0;
      const clavePropuesta = valida ? (proyeccion.claves[cursor++] ?? null) : null;
      return { indice: v.indice, valida, errores: v.errores, clavePropuesta };
    });

    const erroresGlobales: string[] = [];
    if (!grupo.activo) erroresGlobales.push("El grupo de codificación está inactivo");
    if (proyeccion.agotado) {
      erroresGlobales.push(
        `El grupo (prefijo ${grupo.prefijo}) no tiene claves libres suficientes: se necesitan ${validas.length} y hay ${disponibles} disponibles`,
      );
    }

    const { min, max } = rangoDeGrupo(grupo.prefijo);
    const todasValidas = validaciones.every((v) => v.errores.length === 0);

    return {
      grupo: {
        id: grupo.id,
        lineaId: grupo.lineaId,
        departamentoId: grupo.departamentoId,
        prefijo: grupo.prefijo,
        siguienteConsecutivo: grupo.siguienteConsecutivo,
        rangoMin: min,
        rangoMax: max,
        disponibles,
        proximaClave: proyectarClaves(grupo.prefijo, grupo.siguienteConsecutivo, 1, ocupadas).claves[0] ?? null,
      },
      filas,
      clavesOmitidas: proyeccion.omitidas,
      errores: erroresGlobales,
      valido: todasValidas && erroresGlobales.length === 0 && filas.length > 0,
    };
  }

  /**
   * Bloquea el grupo y asigna `cantidad` claves definitivas dentro de la transacción recibida.
   * Debe invocarse como PRIMERA operación relevante de la transacción.
   */
  async asignarClaves(
    tx: Prisma.TransactionClient,
    grupoId: number,
    cantidad: number,
    usuarioId: number,
  ): Promise<{ claves: number[]; omitidas: number[]; grupo: GrupoResuelto }> {
    const bloqueado = await tx.$queryRaw<
      Array<{ id: number; linea_id: number; departamento_id: number; prefijo: number; siguiente_consecutivo: number; activo: number | boolean }>
    >`SELECT id, linea_id, departamento_id, prefijo, siguiente_consecutivo, activo FROM grupos_codificacion_defecto WHERE id = ${grupoId} FOR UPDATE`;

    if (!bloqueado || bloqueado.length === 0) {
      throw new BadRequestError("El grupo de codificación ya no existe");
    }
    const fila = bloqueado[0];
    const grupo: GrupoResuelto = {
      id: toNumber(fila.id),
      lineaId: toNumber(fila.linea_id),
      departamentoId: toNumber(fila.departamento_id),
      prefijo: toNumber(fila.prefijo),
      siguienteConsecutivo: toNumber(fila.siguiente_consecutivo),
      activo: Boolean(Number(fila.activo)),
    };
    if (!grupo.activo) {
      throw new BadRequestError("El grupo de codificación está inactivo");
    }

    const { min, max } = rangoDeGrupo(grupo.prefijo);
    // Lectura bloqueante: ve el último dato confirmado aunque la transacción tenga snapshot previo.
    const ocupadasRows = await tx.$queryRaw<Array<{ clave: number }>>`
      SELECT clave FROM defectos WHERE clave BETWEEN ${min} AND ${max} FOR UPDATE
    `;
    const ocupadas = new Set(ocupadasRows.map((r) => toNumber(r.clave)));

    const proyeccion = proyectarClaves(grupo.prefijo, grupo.siguienteConsecutivo, cantidad, ocupadas);
    if (proyeccion.agotado) {
      throw new ConflictError(
        `El grupo de codificación (prefijo ${grupo.prefijo}) agotó su rango ${min}–${max}: se necesitan ${cantidad} claves y solo hay ${proyeccion.claves.length} libres`,
      );
    }

    await tx.grupoCodificacionDefecto.update({
      where: { id: grupo.id },
      data: {
        siguienteConsecutivo: proyeccion.siguienteConsecutivoResultante,
        actualizadoPor: usuarioId,
      },
    });

    return { claves: proyeccion.claves, omitidas: proyeccion.omitidas, grupo };
  }

  /** Crea todo el lote en una única transacción. Si algo falla, no queda ninguna creación parcial. */
  async crearLote(input: LoteDefectosInput, usuarioId: number) {
    if (!usuarioId) {
      throw new BadRequestError("El usuario creador es obligatorio");
    }
    if (input.filas.length === 0) {
      throw new BadRequestError("El lote debe contener al menos una fila");
    }
    if (input.filas.length > MAX_FILAS_LOTE) {
      throw new BadRequestError(`El lote no puede exceder ${MAX_FILAS_LOTE} filas`);
    }

    await this.validarDepartamento(input.departamentoId);

    const validaciones = validarFilasLote(input.filas as FilaLoteEntrada[]);
    const conErrores = validaciones.filter((v) => v.errores.length > 0);
    if (conErrores.length > 0) {
      throw new BadRequestError("El lote contiene filas inválidas", { filas: conErrores });
    }

    const todasConClaveManual = input.filas.every((f) => f.clave !== undefined && f.clave > 0);

    const grupoPrevio = todasConClaveManual ? null : await this.resolverGrupo(input.lineaId, input.departamentoId);

    try {
      return await prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          let clavesFinales: number[];
          let omitidasFinales: number[] = [];
          let grupoId: number | null = null;
          let prefijo: number | null = null;
          let lineaEfectivaId = input.lineaId;

          if (todasConClaveManual) {
            clavesFinales = input.filas.map((f) => f.clave as number);
            // Validar unicidad manual contra la BD
            const ocupadas = await tx.defecto.findMany({
              where: { clave: { in: clavesFinales } },
              select: { clave: true, defecto: true },
            });
            if (ocupadas.length > 0) {
              const primera = ocupadas[0];
              throw new ConflictError(`La clave #${primera.clave} ya está registrada ('${primera.defecto}')`);
            }
          } else {
            if (!grupoPrevio) {
              throw new BadRequestError("No se encontró un grupo de codificación para asignar claves automáticamente");
            }
            const asignacion = await this.asignarClaves(tx, grupoPrevio.id, input.filas.length, usuarioId);
            clavesFinales = asignacion.claves;
            omitidasFinales = asignacion.omitidas;
            grupoId = asignacion.grupo.id;
            prefijo = asignacion.grupo.prefijo;
            lineaEfectivaId = asignacion.grupo.lineaId;
          }

          const items: Array<{ indice: number; id: number; clave: number }> = [];

          // Lista de departamentos activos directos (DefectoDepartamento):
          const deptosAsociarIds = new Set<number>();
          deptosAsociarIds.add(input.departamentoId);
          if (input.departamentosIds && input.departamentosIds.length > 0) {
            input.departamentosIds.forEach((id) => deptosAsociarIds.add(id));
          }

          // Matriz de etapas de detección (DefectoEtapa):
          const mapaPermitidos = new Map<number, boolean>();
          const deptosLinea = lineaEfectivaId
            ? await tx.departamentoLinea.findMany({
                where: { lineaId: lineaEfectivaId, activo: true, eliminadoEn: null },
                select: { departamentoId: true },
              })
            : await tx.departamento.findMany({
                where: { estado: "ACTIVO", eliminadoEn: null },
                select: { id: true },
              }).then((ds) => ds.map((d) => ({ departamentoId: d.id })));

          const permitidosEspecificos = (input.etapasPermitidasIds && input.etapasPermitidasIds.length > 0)
            ? new Set(input.etapasPermitidasIds)
            : (input.departamentosIds && input.departamentosIds.length > 0)
            ? deptosAsociarIds
            : null;

          const tieneExcepcionesExplicitas = input.etapasPermitidasIds && input.etapasPermitidasIds.length > 0;
          if (tieneExcepcionesExplicitas) {
            const permitidosEspecificos = new Set(input.etapasPermitidasIds);
            permitidosEspecificos.add(input.departamentoId);
            deptosLinea.forEach((d) => {
              mapaPermitidos.set(d.departamentoId, permitidosEspecificos.has(d.departamentoId));
            });
          }

          for (let i = 0; i < input.filas.length; i++) {
            const fila = input.filas[i];
            const clave = clavesFinales[i];
            const nuevo = await tx.defecto.create({
              data: {
                clave,
                defecto: fila.descripcion.trim(),
                clasificacion: fila.clasificacion as ClasificacionDefecto,
                departamentoId: input.departamentoId,
                activo: true,
                creadoPor: usuarioId,
              },
            });

            // Asociar los departamentos elegidos (garantizando el propietario)
            for (const depId of deptosAsociarIds) {
              await tx.defectoDepartamento.create({
                data: {
                  defectoId: nuevo.id,
                  departamentoId: depId,
                  activo: true,
                  creadoPor: usuarioId,
                },
              });
            }

            // Exclusivamente si el usuario configuró etapasPermitidasIds explícitas se crean excepciones
            if (tieneExcepcionesExplicitas) {
              for (const [depId, permitido] of mapaPermitidos.entries()) {
                await tx.defectoEtapa.create({
                  data: {
                    defectoId: nuevo.id,
                    departamentoId: depId,
                    permitido,
                    creadoPor: usuarioId,
                  },
                });
              }
            }

            await auditService.registrarEvento(
              {
                accion: "DEFECTO_CREADO",
                modulo: "CATALOGOS",
                entidad: "Defecto",
                entidadId: nuevo.id.toString(),
                descripcion: `Creación de defecto #${nuevo.clave}: '${nuevo.defecto}' [${nuevo.clasificacion}] (carga masiva)`,
                valoresPosteriores: nuevo as unknown as Record<string, unknown>,
                metadatos: {
                  cargaMasiva: true,
                  grupoCodificacionId: grupoId,
                  lineaId: lineaEfectivaId,
                  prefijo,
                },
                contexto: { usuarioId },
              },
              tx,
            );

            items.push({ indice: i, id: nuevo.id, clave: nuevo.clave });
          }

          return { grupoId, prefijo, items, clavesOmitidas: omitidasFinales };
        },
        { maxWait: 10000, timeout: 120000 },
      );
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        throw new ConflictError("Colisión de claves detectada; el lote no se guardó. Reintente la operación.");
      }
      throw error;
    }
  }

  private async validarDepartamento(departamentoId: number): Promise<void> {
    const depto = await prisma.departamento.findFirst({
      where: { id: departamentoId, estado: "ACTIVO", eliminadoEn: null },
      select: { id: true },
    });
    if (!depto) {
      throw new BadRequestError("El departamento propietario especificado no existe o está inactivo");
    }
  }
}

export const codificacionDefectosService = new CodificacionDefectosService();

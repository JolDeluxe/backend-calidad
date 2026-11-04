import { prisma } from "../../../config/database";
import { NotFoundError, ConflictError, BadRequestError } from "../../../utils/errors";
import { auditService } from "../../audit/services/audit.service";
import type { Prisma } from "@prisma/client";
import { codificacionDefectosService } from "./codificacion-defectos.service";
import { matrizVisibilidadDefectosService } from "./matriz-visibilidad.service";

export interface GetDefectosFiltros {
  clave?: number;
  texto?: string;
  busqueda?: string;
  clasificacion?: "CRITICO" | "MAYOR" | "MENOR";
  departamentoId?: number;
  etapaId?: number;
  categoriaDepartamentoId?: number;
  lineaId?: number;
  lineasIds?: number[];
  activo?: boolean;
  incluirEliminados?: boolean;
  soloEliminados?: boolean;
  limit?: number;
  page?: number;
}

export class DefectosService {
  async getDefectos(filtros: GetDefectosFiltros = {}) {
    const page = Math.max(1, filtros.page || 1);
    const limit = Math.min(1000, Math.max(1, filtros.limit || 20));
    const skip = (page - 1) * limit;

    const where: any = {};

    if (filtros.soloEliminados) {
      where.eliminadoEn = { not: null };
    } else if (!filtros.incluirEliminados) {
      where.eliminadoEn = null;
    }

    // Búsqueda unificada: por texto o prefijo/coincidencia de clave (ej. "11" encuentra claves 1101, 1102... y defectos que contengan "11")
    const terminoBusqueda = filtros.busqueda?.trim() || filtros.texto?.trim();
    if (terminoBusqueda) {
      const pattern = `%${terminoBusqueda}%`;
      const matchingDefectos = await prisma.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM defectos
        WHERE CAST(clave AS CHAR) LIKE ${pattern}
           OR defecto LIKE ${pattern}
      `;
      const idsEncontrados = matchingDefectos.map((m) => m.id);
      where.id = { in: idsEncontrados.length > 0 ? idsEncontrados : [-1] };
    } else if (filtros.clave !== undefined) {
      where.clave = filtros.clave;
    }

    if (filtros.clasificacion) {
      where.clasificacion = filtros.clasificacion;
    }

    if (filtros.activo !== undefined) {
      where.activo = filtros.activo;
    }

    if (filtros.departamentoId) {
      where.departamentoId = filtros.departamentoId;
    } else if (filtros.categoriaDepartamentoId) {
      where.departamento = {
        categoriaDepartamentoId: filtros.categoriaDepartamentoId,
        eliminadoEn: null,
      };
    }

    if (filtros.etapaId) {
      // Resolución unificada: se utiliza el resolver centralizado de la matriz de visibilidad por departamento
      const whereVisibilidad = await matrizVisibilidadDefectosService.construirWhereFiltroDefectosPorDepartamentoDeteccion(
        filtros.etapaId
      );
      where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), whereVisibilidad];
    } else if (filtros.lineasIds && filtros.lineasIds.length > 0) {
      where.OR = [
        {
          departamento: {
            lineasAsociadas: {
              some: {
                lineaId: { in: filtros.lineasIds },
                activo: true,
                eliminadoEn: null,
              },
            },
          },
        },
        {
          departamentos: {
            some: {
              departamento: {
                lineasAsociadas: {
                  some: {
                    lineaId: { in: filtros.lineasIds },
                    activo: true,
                    eliminadoEn: null,
                  },
                },
              },
              activo: true,
              eliminadoEn: null,
            },
          },
        },
      ];
    } else if (filtros.lineaId) {
      where.OR = [
        {
          departamento: {
            lineasAsociadas: {
              some: {
                lineaId: filtros.lineaId,
                activo: true,
                eliminadoEn: null,
              },
            },
          },
        },
        {
          departamentos: {
            some: {
              departamento: {
                lineasAsociadas: {
                  some: {
                    lineaId: filtros.lineaId,
                    activo: true,
                    eliminadoEn: null,
                  },
                },
              },
              activo: true,
              eliminadoEn: null,
            },
          },
        },
      ];
    }

    const [total, items] = await Promise.all([
      prisma.defecto.count({ where }),
      prisma.defecto.findMany({
        where,
        include: {
          departamento: {
            select: { id: true, codigo: true, nombre: true },
          },
          etapas: {
            select: {
              id: true,
              departamentoId: true,
              permitido: true,
              departamento: {
                select: { id: true, codigo: true, nombre: true },
              },
            },
          },
          departamentos: {
            where: { eliminadoEn: null },
            include: {
              departamento: {
                select: {
                  id: true,
                  codigo: true,
                  nombre: true,
                  estado: true,
                  lineasAsociadas: {
                    where: { activo: true, eliminadoEn: null },
                    include: {
                      linea: {
                        select: { id: true, codigo: true, nombre: true },
                      },
                    },
                  },
                },
              },
            },
          },
          creador: { select: { id: true, usuario: true, nombre: true } },
          actualizador: { select: { id: true, usuario: true, nombre: true } },
          eliminador: { select: { id: true, usuario: true, nombre: true } },
        },
        orderBy: { clave: "asc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getDefectoById(id: number) {
    const defecto = await prisma.defecto.findUnique({
      where: { id },
      include: {
        departamento: {
          select: { id: true, codigo: true, nombre: true },
        },
        etapas: {
          select: {
            id: true,
            departamentoId: true,
            permitido: true,
            departamento: {
              select: { id: true, codigo: true, nombre: true },
            },
          },
        },
        departamentos: {
          where: { eliminadoEn: null },
          include: {
            departamento: {
              select: { id: true, codigo: true, nombre: true, estado: true },
            },
          },
        },
        creador: { select: { id: true, usuario: true, nombre: true } },
        actualizador: { select: { id: true, usuario: true, nombre: true } },
        eliminador: { select: { id: true, usuario: true, nombre: true } },
      },
    });

    if (!defecto || defecto.eliminadoEn) {
      throw new NotFoundError("Defecto no encontrado");
    }

    return defecto;
  }

  /**
   * Valida una clave de defecto para una etapa específica en la captura operativa.
   * Distingue con precisión exacta:
   * 1. 'INEXISTENTE': No existe ningún defecto registrado con esa clave.
   * 2. 'INACTIVO': Existe el defecto pero está inactivo (activo = false) o eliminado lógicamente (eliminadoEn != null).
   * 3. 'NO_PERMITIDO': Existe y está activo, pero no está autorizado para inspección en la etapa solicitada.
   * 4. 'VALIDO': Existe, está activo y está autorizado en la etapa.
   */
  async validarDefectoParaCaptura(clave: number, etapaId: number) {
    const defecto = await prisma.defecto.findFirst({
      where: { clave },
      include: {
        departamento: {
          select: { id: true, codigo: true, nombre: true },
        },
        etapas: {
          where: { departamentoId: etapaId },
          select: { id: true, departamentoId: true, permitido: true },
        },
        departamentos: {
          where: { eliminadoEn: null, activo: true },
          select: {
            departamentoId: true,
            departamento: {
              select: {
                id: true,
                codigo: true,
                nombre: true,
                lineasAsociadas: {
                  where: { activo: true, eliminadoEn: null },
                  select: { lineaId: true },
                },
              },
            },
          },
        },
      },
    });

    if (!defecto) {
      return {
        estado: "INEXISTENTE" as const,
        mensaje: "Defecto inexistente",
        defecto: null,
      };
    }

    if (!defecto.activo || defecto.eliminadoEn !== null) {
      return {
        estado: "INACTIVO" as const,
        mensaje: "Defecto inactivo",
        defecto: null,
      };
    }

    const etapaRelacion = defecto.etapas[0];
    const excepcion = etapaRelacion?.permitido;
    const resVis = await matrizVisibilidadDefectosService.resolverVisibilidadConEntidades(
      defecto.departamentoId,
      etapaId,
      excepcion,
      defecto.id
    );

    if (!resVis.permitido) {
      return {
        estado: "NO_PERMITIDO" as const,
        mensaje: "Defecto no permitido",
        defecto: null,
      };
    }

    return {
      estado: "VALIDO" as const,
      mensaje: "Defecto válido",
      defecto: {
        id: defecto.id,
        clave: defecto.clave,
        defecto: defecto.defecto,
        clasificacion: defecto.clasificacion,
        departamentoId: defecto.departamentoId,
        activo: defecto.activo,
        creadoPor: defecto.creadoPor,
        creadoEn: defecto.creadoEn.toISOString(),
        departamento: defecto.departamento,
        etapas: defecto.etapas,
        departamentos: defecto.departamentos,
      },
    };
  }

  async createDefecto(
    data: {
      clave?: number;
      defecto: string;
      clasificacion: "CRITICO" | "MAYOR" | "MENOR";
      departamentoId: number;
      lineaId?: number;
      departamentosIds?: number[];
      etapasPermitidasIds?: number[];
    },
    usuarioId: number
  ) {
    if (!usuarioId) {
      throw new BadRequestError("El usuario creador es obligatorio");
    }

    if (!data.departamentoId) {
      throw new BadRequestError("El departamento propietario es obligatorio y debe seleccionarse explícitamente");
    }

    const deptoExiste = await prisma.departamento.findFirst({
      where: { id: data.departamentoId, estado: "ACTIVO", eliminadoEn: null },
    });
    if (!deptoExiste) {
      throw new BadRequestError("El departamento propietario especificado no existe o está inactivo");
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      let claveDefinitiva: number;
      let lineaAsociadaId: number | undefined = data.lineaId;

      if (data.clave !== undefined && data.clave > 0) {
        // Validación manual de clave: comprobar que no exista en defectos (activos o eliminados)
        const claveExistente = await tx.defecto.findUnique({
          where: { clave: data.clave },
          select: { id: true, clave: true, defecto: true },
        });
        if (claveExistente) {
          throw new ConflictError(`Ya existe un defecto registrado con la clave #${data.clave} ('${claveExistente.defecto}')`);
        }
        claveDefinitiva = data.clave;

        // Si no se pasó lineaId explícita, resolver la primera línea a la que pertenece el depto
        if (!lineaAsociadaId) {
          const dl = await tx.departamentoLinea.findFirst({
            where: { departamentoId: data.departamentoId, activo: true, eliminadoEn: null },
            select: { lineaId: true },
          });
          if (dl) lineaAsociadaId = dl.lineaId;
        }
      } else {
        // Fallback automático si no se proporcionó clave manual
        const grupo = await codificacionDefectosService.resolverGrupo(data.lineaId, data.departamentoId, tx);
        const asignacion = await codificacionDefectosService.asignarClaves(tx, grupo.id, 1, usuarioId);
        claveDefinitiva = asignacion.claves[0];
        lineaAsociadaId = grupo.lineaId;
      }

      const deptoPropietarioId = data.departamentoId;

      const nuevo = await tx.defecto.create({
        data: {
          clave: claveDefinitiva,
          defecto: data.defecto.trim(),
          clasificacion: data.clasificacion,
          departamentoId: deptoPropietarioId,
          activo: true,
          creadoPor: usuarioId,
        },
      });

      if (data.departamentosIds && data.departamentosIds.length > 0) {
        for (const deptoId of data.departamentosIds) {
          await tx.defectoDepartamento.create({
            data: {
              defectoId: nuevo.id,
              departamentoId: deptoId,
              activo: true,
              creadoPor: usuarioId,
            },
          });
        }
      }

      // Sincronizar matriz de etapas de detección (DefectoEtapa):
      // 1. Si se indicaron etapasPermitidasIds explícitas desde la interfaz, se respetan como excepciones individuales.
      // 2. Si no, se consulta la Matriz Maestra de Visibilidad (`DepartamentoVisibilidadDefecto`) del departamento propietario.
      // 3. Fallback: departamentos evaluadores (departamentosIds) o todos los de la línea.
      const mapaPermitidos = new Map<number, boolean>();

      // Obtener todos los departamentos activos de la línea para registrar la matriz completa
      const asignacionesLinea = lineaAsociadaId
        ? await tx.departamentoLinea.findMany({
            where: { lineaId: lineaAsociadaId, activo: true, eliminadoEn: null },
            select: { departamentoId: true },
          })
        : await tx.departamento.findMany({
            where: { estado: "ACTIVO", eliminadoEn: null },
            select: { id: true },
          }).then((ds) => ds.map((d) => ({ departamentoId: d.id })));

      // GOBERNANZA DE HERENCIA DINÁMICA:
      // Si el usuario especificó etapasPermitidasIds explícitas (excepciones individuales), se crean solo esas excepciones.
      // Si NO se enviaron etapasPermitidasIds explícitas, NO se crean filas estáticas en DefectoEtapa:
      // el defecto hereda en tiempo real las reglas de DepartamentoVisibilidadDefecto (Matriz Maestra).
      if (data.etapasPermitidasIds && data.etapasPermitidasIds.length > 0) {
        const permitidosSet = new Set(data.etapasPermitidasIds);
        permitidosSet.add(deptoPropietarioId);

        for (const a of asignacionesLinea) {
          const esPermitido = permitidosSet.has(a.departamentoId);
          await tx.defectoEtapa.create({
            data: {
              defectoId: nuevo.id,
              departamentoId: a.departamentoId,
              permitido: esPermitido,
              creadoPor: usuarioId,
            },
          });
        }
      }

      await auditService.registrarEvento({
        accion: "DEFECTO_CREADO",
        modulo: "CATALOGOS",
        entidad: "Defecto",
        entidadId: nuevo.id.toString(),
        descripcion: `Creación de defecto #${nuevo.clave}: '${nuevo.defecto}' [${nuevo.clasificacion}]`,
        valoresPosteriores: nuevo as any,
        contexto: { usuarioId },
      }, tx);

      return nuevo;
    }, {
      maxWait: 5000,
      timeout: 10000,
    });
  }

  async updateDefecto(
    id: number,
    data: { defecto?: string; clasificacion?: "CRITICO" | "MAYOR" | "MENOR"; departamentoId?: number },
    usuarioId: number
  ) {
    const actual = await this.getDefectoById(id);

    if (actual.eliminadoEn) {
      throw new BadRequestError("Un defecto eliminado no puede modificarse mediante actualización ordinaria");
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const cambioPropietario = data.departamentoId !== undefined && data.departamentoId !== actual.departamentoId;

      const actualizado = await tx.defecto.update({
        where: { id },
        data: {
          defecto: data.defecto ? data.defecto.trim() : undefined,
          clasificacion: data.clasificacion,
          departamentoId: data.departamentoId,
          actualizadoPor: usuarioId,
        },
      });

      // Regla 3: Si un defecto cambia de departamento propietario, recalcular los permisos heredados de la matriz
      if (cambioPropietario && data.departamentoId) {
        const nuevoPropietarioId = data.departamentoId;
        const plantillaNueva = await matrizVisibilidadDefectosService.obtenerPlantillaEtapasParaPropietario(nuevoPropietarioId);
        if (plantillaNueva.size > 0) {
          for (const [destinoId, permitido] of plantillaNueva.entries()) {
            await tx.defectoEtapa.upsert({
              where: {
                unique_defecto_etapa: { defectoId: id, departamentoId: destinoId },
              },
              create: {
                defectoId: id,
                departamentoId: destinoId,
                permitido: destinoId === nuevoPropietarioId ? true : permitido,
                creadoPor: usuarioId,
                actualizadoPor: usuarioId,
              },
              update: {
                permitido: destinoId === nuevoPropietarioId ? true : permitido,
                actualizadoPor: usuarioId,
              },
            });
          }
        }
      }

      await auditService.registrarEvento({
        accion: "DEFECTO_ACTUALIZADO",
        modulo: "CATALOGOS",
        entidad: "Defecto",
        entidadId: id.toString(),
        descripcion: `Actualización de datos del defecto #${actual.clave}`,
        valoresAnteriores: actual as any,
        valoresPosteriores: actualizado as any,
        contexto: { usuarioId },
      }, tx);

      return actualizado;
    });
  }

  /**
   * Operación administrativa específica y altamente auditada para modificar la clave de negocio de un defecto.
   * Ajusta además la secuencia en InnoDB para evitar colisiones futuras.
   */
  async updateClaveDefecto(
    id: number,
    nuevaClave: number,
    usuarioId: number
  ) {
    const actual = await this.getDefectoById(id);

    if (actual.clave === nuevaClave) {
      return actual;
    }

    // Verificar si la clave ya existe (incluso lógicamente eliminada)
    const conflicto = await prisma.defecto.findUnique({
      where: { clave: nuevaClave },
    });

    if (conflicto) {
      throw new ConflictError(
        `La clave #${nuevaClave} ya está en uso por otro defecto.`
      );
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const actualizado = await tx.defecto.update({
        where: { id },
        data: {
          clave: nuevaClave,
          actualizadoPor: usuarioId,
        },
      });

      // Si la nueva clave es superior o igual al valor siguiente de la secuencia, adelantar la secuencia
      const seqRows = await tx.$queryRaw<Array<{ id: number; siguiente_clave: number }>>`
        SELECT siguiente_clave FROM secuencias_clave_defecto WHERE id = 1 FOR UPDATE
      `;
      if (seqRows && seqRows.length > 0 && nuevaClave >= seqRows[0].siguiente_clave) {
        await tx.$executeRaw`
          UPDATE secuencias_clave_defecto
          SET siguiente_clave = ${nuevaClave + 1},
              fecha_actualizacion = NOW(3)
          WHERE id = 1
        `;
      }

      await auditService.registrarEvento({
        accion: "DEFECTO_CLAVE_MODIFICADA",
        modulo: "CATALOGOS",
        entidad: "Defecto",
        entidadId: id.toString(),
        descripcion: `Modificación de clave para defecto #${actual.clave} -> #${nuevaClave}`,
        valoresAnteriores: { clave: actual.clave },
        valoresPosteriores: { clave: nuevaClave },
        contexto: { usuarioId },
      }, tx);

      return actualizado;
    });
  }

  async updateEstadoDefecto(id: number, activo: boolean, usuarioId: number) {
    const actual = await prisma.defecto.findUnique({ where: { id } });
    if (!actual) {
      throw new NotFoundError("Defecto no encontrado");
    }

    if (actual.eliminadoEn) {
      throw new BadRequestError("Un defecto eliminado lógicamente no puede reactivarse con actualización ordinaria de estado");
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const actualizado = await tx.defecto.update({
        where: { id },
        data: {
          activo,
          actualizadoPor: usuarioId,
        },
      });

      await auditService.registrarEvento({
        accion: "DEFECTO_ESTADO_MODIFICADO",
        modulo: "CATALOGOS",
        entidad: "Defecto",
        entidadId: id.toString(),
        descripcion: `Cambio de estado del defecto #${actual.clave} a ${activo ? 'ACTIVO' : 'INACTIVO'}`,
        valoresAnteriores: { activo: actual.activo },
        valoresPosteriores: { activo },
        contexto: { usuarioId },
      }, tx);

      return actualizado;
    });
  }

  async deleteDefecto(id: number, usuarioId: number) {
    const actual = await this.getDefectoById(id);

    // En futuras integraciones se validará si existen inspecciones históricas asociadas a este defecto
    // Las eliminaciones son estrictamente lógicas

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const eliminado = await tx.defecto.update({
        where: { id },
        data: {
          activo: false,
          eliminadoPor: usuarioId,
          eliminadoEn: new Date(),
        },
      });

      // Desactivar lógicamente asociaciones con departamentos
      await tx.defectoDepartamento.updateMany({
        where: { defectoId: id },
        data: {
          activo: false,
          eliminadoPor: usuarioId,
          eliminadoEn: new Date(),
        },
      });

      await auditService.registrarEvento({
        accion: "DEFECTO_ELIMINADO",
        modulo: "CATALOGOS",
        entidad: "Defecto",
        entidadId: id.toString(),
        descripcion: `Borrado lógico del defecto #${actual.clave}: '${actual.defecto}'`,
        valoresAnteriores: actual as any,
        valoresPosteriores: eliminado as any,
        contexto: { usuarioId },
      }, tx);

      return { id, eliminado: true, clave: actual.clave };
    });
  }

  async reactivarDefecto(id: number, usuarioId: number) {
    const actual = await prisma.defecto.findUnique({
      where: { id },
      include: {
        departamento: {
          select: { id: true, codigo: true, nombre: true },
        },
        etapas: {
          select: {
            id: true,
            departamentoId: true,
            permitido: true,
            departamento: {
              select: { id: true, codigo: true, nombre: true },
            },
          },
        },
        departamentos: {
          include: { departamento: true },
        },
      },
    });

    if (!actual) {
      throw new NotFoundError(`El defecto con ID ${id} no existe`);
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const reactivado = await tx.defecto.update({
        where: { id },
        data: {
          activo: true,
          eliminadoPor: null,
          eliminadoEn: null,
          actualizadoPor: usuarioId,
        },
      });

      // Reactivar asociaciones con departamentos
      await tx.defectoDepartamento.updateMany({
        where: { defectoId: id },
        data: {
          activo: true,
          eliminadoPor: null,
          eliminadoEn: null,
          actualizadoPor: usuarioId,
        },
      });

      await auditService.registrarEvento({
        accion: "DEFECTO_REACTIVADO",
        modulo: "CATALOGOS",
        entidad: "Defecto",
        entidadId: id.toString(),
        descripcion: `Reactivación del defecto #${actual.clave}: '${actual.defecto}'`,
        valoresAnteriores: actual as any,
        valoresPosteriores: reactivado as any,
        contexto: { usuarioId },
      }, tx);

      return { id, reactivado: true, clave: actual.clave, defecto: reactivado };
    });
  }

  async syncDefectoDepartamentos(
    defectoId: number,
    departamentos: Array<{ departamentoId: number; activo: boolean }>,
    usuarioId: number
  ) {
    await this.getDefectoById(defectoId);

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const resultados = [];
      for (const item of departamentos) {
        const asoc = await tx.defectoDepartamento.upsert({
          where: {
            unique_defecto_departamento: {
              defectoId,
              departamentoId: item.departamentoId,
            },
          },
          update: {
            activo: item.activo,
            actualizadoPor: usuarioId,
            eliminadoEn: null,
            eliminadoPor: null,
          },
          create: {
            defectoId,
            departamentoId: item.departamentoId,
            activo: item.activo,
            creadoPor: usuarioId,
          },
        });
        resultados.push(asoc);
      }

      await auditService.registrarEvento({
        accion: "DEFECTO_DEPARTAMENTOS_SINCRONIZADOS",
        modulo: "CATALOGOS",
        entidad: "DefectoDepartamento",
        entidadId: defectoId.toString(),
        descripcion: `Actualización de departamentos asociados al defecto #${defectoId}`,
        valoresPosteriores: { departamentos },
        contexto: { usuarioId },
      }, tx);

      return resultados;
    });
  }

  async getConteoLineas(): Promise<{
    lineas: Array<{ id: number; nombre: string; total: number }>;
    todas: number;
  }> {
    const lineasActivas = await prisma.linea.findMany({
      where: { estado: "ACTIVO", eliminadoEn: null },
      orderBy: { id: "asc" },
      select: { id: true, nombre: true },
    });

    const conteosLineas = await Promise.all(
      lineasActivas.map(async (lin) => {
        const total = await prisma.defecto.count({
          where: {
            activo: true,
            eliminadoEn: null,
            OR: [
              {
                departamento: {
                  lineasAsociadas: {
                    some: { lineaId: lin.id, activo: true, eliminadoEn: null },
                  },
                },
              },
              {
                departamentos: {
                  some: {
                    departamento: {
                      lineasAsociadas: {
                        some: { lineaId: lin.id, activo: true, eliminadoEn: null },
                      },
                    },
                    activo: true,
                    eliminadoEn: null,
                  },
                },
              },
            ],
          },
        });
        return { id: lin.id, nombre: lin.nombre, total };
      })
    );

    const todas = await prisma.defecto.count({
      where: {
        activo: true,
        eliminadoEn: null,
      },
    });

    return {
      lineas: conteosLineas,
      todas,
    };
  }

  async toggleDefectoDepartamento(
    defectoId: number,
    departamentoId: number,
    activo: boolean,
    usuarioId: number
  ) {
    await this.getDefectoById(defectoId);

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const asoc = await tx.defectoDepartamento.upsert({
        where: {
          unique_defecto_departamento: {
            defectoId,
            departamentoId,
          },
        },
        update: {
          activo,
          actualizadoPor: usuarioId,
          eliminadoEn: null,
          eliminadoPor: null,
        },
        create: {
          defectoId,
          departamentoId,
          activo,
          creadoPor: usuarioId,
        },
      });

      await auditService.registrarEvento({
        accion: "DEFECTO_DEPARTAMENTO_ASOCIACION_MODIFICADA",
        modulo: "CATALOGOS",
        entidad: "DefectoDepartamento",
        entidadId: `${defectoId}-${departamentoId}`,
        descripcion: `Asociación defecto #${defectoId} con departamento #${departamentoId} establecida en ${activo ? 'ACTIVA' : 'INACTIVA'}`,
        valoresPosteriores: { defectoId, departamentoId, activo },
        contexto: { usuarioId },
      }, tx);

      return asoc;
    });
  }
  async syncDefectoEtapas(
    defectoId: number,
    etapas: Array<{ departamentoId: number; permitido: boolean }>,
    usuarioId: number
  ) {
    const defecto = await this.getDefectoById(defectoId);

    // Validar que los departamentos especificados existan
    const deptosIds = etapas.map((e) => e.departamentoId);
    const deptosEncontrados = await prisma.departamento.findMany({
      where: { id: { in: deptosIds }, estado: "ACTIVO", eliminadoEn: null },
      select: { id: true, nombre: true },
    });

    if (deptosEncontrados.length !== deptosIds.length) {
      const encontradosSet = new Set(deptosEncontrados.map((d) => d.id));
      const faltantes = deptosIds.filter((id) => !encontradosSet.has(id));
      throw new BadRequestError(
        `Uno o más departamentos de etapa no existen o están inactivos: IDs [${faltantes.join(", ")}]`
      );
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const resultados = [];
      const estadosPrevios = await tx.defectoEtapa.findMany({
        where: { defectoId },
        select: { departamentoId: true, permitido: true },
      });

      for (const item of etapas) {
        const registro = await tx.defectoEtapa.upsert({
          where: {
            unique_defecto_etapa: {
              defectoId,
              departamentoId: item.departamentoId,
            },
          },
          update: {
            permitido: item.permitido,
            actualizadoPor: usuarioId,
          },
          create: {
            defectoId,
            departamentoId: item.departamentoId,
            permitido: item.permitido,
            creadoPor: usuarioId,
          },
          include: {
            departamento: { select: { id: true, codigo: true, nombre: true } },
          },
        });
        resultados.push(registro);
      }

      await auditService.registrarEvento({
        accion: "DEFECTO_ETAPAS_ACTUALIZADAS",
        modulo: "CATALOGOS",
        entidad: "DefectoEtapa",
        entidadId: defectoId.toString(),
        descripcion: `Actualización de matriz de etapas de detección para defecto #${defecto.clave}`,
        valoresAnteriores: estadosPrevios as any,
        valoresPosteriores: etapas as any,
        contexto: { usuarioId },
      }, tx);

      return resultados;
    });
  }
}

export const defectosService = new DefectosService();

import { prisma } from "../../../config/database";
import { NotFoundError, ConflictError } from "../../../utils/errors";
import { auditService } from "../../audit/services/audit.service";
import type { Prisma } from "@prisma/client";

export interface GetDepartamentosFiltros {
  lineaId?: number;
  tipoOperacionId?: number;
  categoriaDepartamentoId?: number;
  estado?: "ACTIVO" | "INACTIVO";
  busqueda?: string;
  incluirEliminados?: boolean;
}

export class DepartamentosService {
  async getDepartamentos(filtros: GetDepartamentosFiltros = {}) {
    const where: any = {};

    if (!filtros.incluirEliminados) {
      where.eliminadoEn = null;
    }

    if (filtros.estado) {
      where.estado = filtros.estado;
    }

    if (filtros.busqueda) {
      where.OR = [
        { nombre: { contains: filtros.busqueda } },
        { codigo: { contains: filtros.busqueda } },
      ];
    }

    if (filtros.categoriaDepartamentoId) {
      where.categoriaDepartamentoId = filtros.categoriaDepartamentoId;
    }

    if (filtros.lineaId) {
      where.lineasAsociadas = {
        some: {
          lineaId: filtros.lineaId,
          activo: true,
          eliminadoEn: null,
        },
      };
    } else if (filtros.tipoOperacionId) {
      where.lineasAsociadas = {
        some: {
          linea: {
            tipoOperacionId: filtros.tipoOperacionId,
            eliminadoEn: null,
          },
          activo: true,
          eliminadoEn: null,
        },
      };
    }

    return prisma.departamento.findMany({
      where,
      include: {
        categoria: {
          select: { id: true, nombre: true, activo: true },
        },
        lineasAsociadas: {
          where: { eliminadoEn: null, activo: true },
          include: {
            linea: {
              select: {
                id: true,
                codigo: true,
                nombre: true,
                tipoOperacion: { select: { id: true, codigo: true, nombre: true } },
              },
            },
          },
        },
      },
      orderBy: { id: "asc" },
    });
  }

  async getDepartamentoById(id: number) {
    const departamento = await prisma.departamento.findUnique({
      where: { id },
      include: {
        categoria: {
          select: { id: true, nombre: true, activo: true },
        },
        lineasAsociadas: {
          where: { eliminadoEn: null },
          include: {
            linea: {
              include: { tipoOperacion: true },
            },
          },
        },
        defectosAsociados: {
          where: { eliminadoEn: null },
          include: {
            defecto: true,
          },
        },
      },
    });

    if (!departamento || departamento.eliminadoEn) {
      throw new NotFoundError("Departamento no encontrado");
    }

    return departamento;
  }

  async createDepartamento(
    data: { codigo?: string; nombre: string; categoriaDepartamentoId?: number | null; numeroLineas?: number; lineasIds?: number[] },
    usuarioId?: number
  ) {
    let codigo = data.codigo?.trim().toUpperCase();
    if (!codigo) {
      const slug = data.nombre
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]/g, "_")
        .toUpperCase()
        .slice(0, 20);
      codigo = slug;
      let counter = 1;
      while (await prisma.departamento.findUnique({ where: { codigo } })) {
        codigo = `${slug.slice(0, 16)}_${counter}`;
        counter++;
      }
    }

    const existente = await prisma.departamento.findUnique({
      where: { codigo },
    });

    if (existente && !existente.eliminadoEn) {
      throw new ConflictError(`El código de departamento '${codigo}' ya existe`);
    }

    if (data.categoriaDepartamentoId) {
      const catExiste = await prisma.categoriaDepartamento.findFirst({
        where: { id: data.categoriaDepartamentoId, eliminadoEn: null },
      });
      if (!catExiste) {
        throw new NotFoundError("La categoría de departamento especificada no existe");
      }
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      let depto;
      if (existente && existente.eliminadoEn) {
        depto = await tx.departamento.update({
          where: { id: existente.id },
          data: {
            nombre: data.nombre,
            categoriaDepartamentoId: data.categoriaDepartamentoId ?? null,
            numeroLineas: data.numeroLineas ?? 1,
            estado: "ACTIVO",
            creadoPor: usuarioId,
            actualizadoPor: usuarioId,
            eliminadoEn: null,
            eliminadoPor: null,
          },
          include: {
            categoria: true,
          },
        });
      } else {
        depto = await tx.departamento.create({
          data: {
            codigo,
            nombre: data.nombre,
            categoriaDepartamentoId: data.categoriaDepartamentoId ?? null,
            numeroLineas: data.numeroLineas ?? 1,
            creadoPor: usuarioId,
          },
          include: {
            categoria: true,
          },
        });
      }

      if (data.lineasIds && data.lineasIds.length > 0) {
        for (const lineaId of data.lineasIds) {
          await tx.departamentoLinea.upsert({
            where: {
              unique_depto_linea: {
                departamentoId: depto.id,
                lineaId,
              },
            },
            update: {
              activo: true,
              eliminadoEn: null,
              eliminadoPor: null,
              actualizadoPor: usuarioId,
            },
            create: {
              departamentoId: depto.id,
              lineaId,
              activo: true,
              creadoPor: usuarioId,
            },
          });
        }
      }

      await auditService.registrarEvento({
        accion: "DEPARTAMENTO_CREADO",
        modulo: "CATALOGOS",
        entidad: "Departamento",
        entidadId: depto.id.toString(),
        descripcion: `Creación de departamento '${depto.nombre}' [${depto.codigo}]`,
        valoresPosteriores: depto as any,
        contexto: { usuarioId },
      }, tx);

      return depto;
    });
  }

  async updateDepartamento(
    id: number,
    data: { nombre?: string; codigo?: string; categoriaDepartamentoId?: number | null; numeroLineas?: number; lineasIds?: number[] },
    usuarioId?: number
  ) {
    const actual = await this.getDepartamentoById(id);

    if (data.codigo && data.codigo !== actual.codigo) {
      const otro = await prisma.departamento.findUnique({ where: { codigo: data.codigo } });
      if (otro && otro.id !== id && !otro.eliminadoEn) {
        throw new ConflictError(`El código de departamento '${data.codigo}' ya está en uso`);
      }
    }

    if (data.categoriaDepartamentoId !== undefined && data.categoriaDepartamentoId !== null) {
      const catExiste = await prisma.categoriaDepartamento.findFirst({
        where: { id: data.categoriaDepartamentoId, eliminadoEn: null },
      });
      if (!catExiste) {
        throw new NotFoundError("La categoría de departamento especificada no existe");
      }
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const actualizado = await tx.departamento.update({
        where: { id },
        data: {
          nombre: data.nombre,
          codigo: data.codigo,
          categoriaDepartamentoId: data.categoriaDepartamentoId !== undefined ? data.categoriaDepartamentoId : undefined,
          numeroLineas: data.numeroLineas !== undefined ? data.numeroLineas : undefined,
          actualizadoPor: usuarioId,
        },
        include: {
          categoria: true,
        },
      });

      if (data.lineasIds) {
        // Desactivar las que ya no están
        await tx.departamentoLinea.updateMany({
          where: {
            departamentoId: id,
            lineaId: { notIn: data.lineasIds },
          },
          data: {
            activo: false,
            actualizadoPor: usuarioId,
          },
        });

        // Activar o crear las nuevas
        for (const lid of data.lineasIds) {
          await tx.departamentoLinea.upsert({
            where: {
              unique_depto_linea: {
                departamentoId: id,
                lineaId: lid,
              },
            },
            update: {
              activo: true,
              actualizadoPor: usuarioId,
              eliminadoEn: null,
              eliminadoPor: null,
            },
            create: {
              departamentoId: id,
              lineaId: lid,
              activo: true,
              creadoPor: usuarioId,
            },
          });
        }
      }

      await auditService.registrarEvento({
        accion: "DEPARTAMENTO_ACTUALIZADO",
        modulo: "CATALOGOS",
        entidad: "Departamento",
        entidadId: id.toString(),
        descripcion: `Actualización del departamento '${actualizado.nombre}'`,
        valoresAnteriores: actual as any,
        valoresPosteriores: actualizado as any,
        contexto: { usuarioId },
      }, tx);

      return actualizado;
    });
  }

  async updateEstadoDepartamento(id: number, estado: "ACTIVO" | "INACTIVO", usuarioId?: number) {
    const actual = await this.getDepartamentoById(id);

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const actualizado = await tx.departamento.update({
        where: { id },
        data: {
          estado,
          actualizadoPor: usuarioId,
        },
      });

      await auditService.registrarEvento({
        accion: "DEPARTAMENTO_ESTADO_MODIFICADO",
        modulo: "CATALOGOS",
        entidad: "Departamento",
        entidadId: id.toString(),
        descripcion: `Cambio de estado del departamento '${actualizado.nombre}' a ${estado}`,
        valoresAnteriores: { estado: actual.estado },
        valoresPosteriores: { estado },
        contexto: { usuarioId },
      }, tx);

      return actualizado;
    });
  }

  async deleteDepartamento(id: number, usuarioId?: number) {
    const actual = await this.getDepartamentoById(id);

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const eliminado = await tx.departamento.update({
        where: { id },
        data: {
          estado: "INACTIVO",
          eliminadoPor: usuarioId,
          eliminadoEn: new Date(),
        },
      });

      // Desactivar lógicamente asociaciones con líneas
      await tx.departamentoLinea.updateMany({
        where: { departamentoId: id },
        data: {
          activo: false,
          eliminadoPor: usuarioId,
          eliminadoEn: new Date(),
        },
      });

      await auditService.registrarEvento({
        accion: "DEPARTAMENTO_ELIMINADO",
        modulo: "CATALOGOS",
        entidad: "Departamento",
        entidadId: id.toString(),
        descripcion: `Borrado lógico del departamento '${actual.nombre}'`,
        valoresAnteriores: actual as any,
        valoresPosteriores: eliminado as any,
        contexto: { usuarioId },
      }, tx);

      return { id, eliminado: true };
    });
  }

  async syncDepartamentoLineas(
    departamentoId: number,
    lineas: Array<{ lineaId: number; activo: boolean }>,
    usuarioId?: number
  ) {
    await this.getDepartamentoById(departamentoId);

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const resultados = [];
      for (const item of lineas) {
        const asoc = await tx.departamentoLinea.upsert({
          where: {
            unique_depto_linea: {
              departamentoId,
              lineaId: item.lineaId,
            },
          },
          update: {
            activo: item.activo,
            actualizadoPor: usuarioId,
            eliminadoEn: null,
            eliminadoPor: null,
          },
          create: {
            departamentoId,
            lineaId: item.lineaId,
            activo: item.activo,
            creadoPor: usuarioId,
          },
        });
        resultados.push(asoc);
      }

      await auditService.registrarEvento({
        accion: "DEPARTAMENTO_LINEAS_SINCRONIZADAS",
        modulo: "CATALOGOS",
        entidad: "DepartamentoLinea",
        entidadId: departamentoId.toString(),
        descripcion: `Sincronización de líneas del departamento #${departamentoId}`,
        valoresPosteriores: { lineas },
        contexto: { usuarioId },
      }, tx);

      return resultados;
    });
  }
}

export const departamentosService = new DepartamentosService();

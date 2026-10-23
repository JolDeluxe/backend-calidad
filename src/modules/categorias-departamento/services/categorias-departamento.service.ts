import { prisma } from "../../../config/database";
import { NotFoundError, ConflictError } from "../../../utils/errors";
import { auditService } from "../../audit/services/audit.service";
import type { Prisma } from "@prisma/client";

export interface GetCategoriasDepartamentoFiltros {
  activo?: boolean;
  busqueda?: string;
  incluirEliminados?: boolean;
}

export class CategoriasDepartamentoService {
  async getCategorias(filtros: GetCategoriasDepartamentoFiltros = {}) {
    const where: Prisma.CategoriaDepartamentoWhereInput = {};

    if (!filtros.incluirEliminados) {
      where.eliminadoEn = null;
    }

    if (filtros.activo !== undefined) {
      where.activo = filtros.activo;
    }

    if (filtros.busqueda) {
      where.nombre = { contains: filtros.busqueda };
    }

    return prisma.categoriaDepartamento.findMany({
      where,
      include: {
        departamentos: {
          where: { eliminadoEn: null },
          select: { id: true, codigo: true, nombre: true, estado: true },
        },
      },
      orderBy: { nombre: "asc" },
    });
  }

  async getCategoriaById(id: number) {
    const categoria = await prisma.categoriaDepartamento.findFirst({
      where: { id, eliminadoEn: null },
      include: {
        departamentos: {
          where: { eliminadoEn: null },
          select: { id: true, codigo: true, nombre: true, estado: true },
        },
      },
    });

    if (!categoria) {
      throw new NotFoundError("Categoría de departamento no encontrada");
    }

    return categoria;
  }

  async createCategoria(
    data: { nombre: string; descripcion?: string | null; activo?: boolean },
    usuarioId?: number
  ) {
    const nombreNormalizado = data.nombre.trim();

    // Validar unicidad insensible a mayúsculas y espacios sobrantes
    const existe = await prisma.categoriaDepartamento.findFirst({
      where: {
        nombre: nombreNormalizado,
        eliminadoEn: null,
      },
    });

    if (existe) {
      throw new ConflictError(`La categoría '${nombreNormalizado}' ya existe`);
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const nueva = await tx.categoriaDepartamento.create({
        data: {
          nombre: nombreNormalizado,
          descripcion: data.descripcion,
          activo: data.activo ?? true,
          creadoPor: usuarioId,
        },
        include: {
          departamentos: { select: { id: true, codigo: true, nombre: true } },
        },
      });

      await auditService.registrarEvento(
        {
          accion: "CATEGORIA_DEPARTAMENTO_CREADA",
          modulo: "CATALOGOS",
          entidad: "CategoriaDepartamento",
          entidadId: nueva.id.toString(),
          descripcion: `Creación de la categoría de departamento '${nueva.nombre}'`,
          valoresPosteriores: nueva as any,
          contexto: { usuarioId },
        },
        tx
      );

      return nueva;
    });
  }

  async updateCategoria(
    id: number,
    data: { nombre?: string; descripcion?: string | null; activo?: boolean },
    usuarioId?: number
  ) {
    const actual = await this.getCategoriaById(id);

    if (data.nombre && data.nombre.trim() !== actual.nombre) {
      const nombreNormalizado = data.nombre.trim();
      const duplicado = await prisma.categoriaDepartamento.findFirst({
        where: {
          nombre: nombreNormalizado,
          id: { not: id },
          eliminadoEn: null,
        },
      });
      if (duplicado) {
        throw new ConflictError(`Ya existe otra categoría con el nombre '${nombreNormalizado}'`);
      }
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const actualizada = await tx.categoriaDepartamento.update({
        where: { id },
        data: {
          ...(data.nombre ? { nombre: data.nombre.trim() } : {}),
          ...(data.descripcion !== undefined ? { descripcion: data.descripcion } : {}),
          ...(data.activo !== undefined ? { activo: data.activo } : {}),
          actualizadoPor: usuarioId,
        },
        include: {
          departamentos: {
            where: { eliminadoEn: null },
            select: { id: true, codigo: true, nombre: true, estado: true },
          },
        },
      });

      await auditService.registrarEvento(
        {
          accion: "CATEGORIA_DEPARTAMENTO_ACTUALIZADA",
          modulo: "CATALOGOS",
          entidad: "CategoriaDepartamento",
          entidadId: id.toString(),
          descripcion: `Actualización de la categoría de departamento '${actualizada.nombre}'`,
          valoresAnteriores: actual as any,
          valoresPosteriores: actualizada as any,
          contexto: { usuarioId },
        },
        tx
      );

      return actualizada;
    });
  }

  async updateEstado(id: number, activo: boolean, usuarioId?: number) {
    const actual = await this.getCategoriaById(id);

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const actualizada = await tx.categoriaDepartamento.update({
        where: { id },
        data: {
          activo,
          actualizadoPor: usuarioId,
        },
        include: {
          departamentos: {
            where: { eliminadoEn: null },
            select: { id: true, codigo: true, nombre: true, estado: true },
          },
        },
      });

      await auditService.registrarEvento(
        {
          accion: activo ? "CATEGORIA_DEPARTAMENTO_ACTIVADA" : "CATEGORIA_DEPARTAMENTO_DESACTIVADA",
          modulo: "CATALOGOS",
          entidad: "CategoriaDepartamento",
          entidadId: id.toString(),
          descripcion: `Cambio de estado de categoría '${actualizada.nombre}' a ${activo ? "ACTIVO" : "INACTIVO"}`,
          valoresAnteriores: { activo: actual.activo },
          valoresPosteriores: { activo },
          contexto: { usuarioId },
        },
        tx
      );

      return actualizada;
    });
  }

  async deleteCategoria(id: number, usuarioId?: number) {
    const actual = await this.getCategoriaById(id);

    // Validación estricta: No permitir borrado lógico si tiene departamentos asociados
    const deptosAsociados = await prisma.departamento.count({
      where: {
        categoriaDepartamentoId: id,
        eliminadoEn: null,
      },
    });

    if (deptosAsociados > 0) {
      throw new ConflictError(
        `No se puede eliminar la categoría '${actual.nombre}' porque tiene ${deptosAsociados} departamento(s) asignado(s). Reasigne o desvincule los departamentos primero.`
      );
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const eliminada = await tx.categoriaDepartamento.update({
        where: { id },
        data: {
          activo: false,
          eliminadoPor: usuarioId,
          eliminadoEn: new Date(),
        },
      });

      await auditService.registrarEvento(
        {
          accion: "CATEGORIA_DEPARTAMENTO_ELIMINADA",
          modulo: "CATALOGOS",
          entidad: "CategoriaDepartamento",
          entidadId: id.toString(),
          descripcion: `Borrado lógico de la categoría de departamento '${actual.nombre}'`,
          valoresAnteriores: actual as any,
          valoresPosteriores: eliminada as any,
          contexto: { usuarioId },
        },
        tx
      );

      return {
        mensaje: "Categoría eliminada lógicamente de manera exitosa",
        id,
      };
    });
  }
}

export const categoriasDepartamentoService = new CategoriasDepartamentoService();

import { prisma } from "../../../config/database";
import { NotFoundError, ConflictError, BadRequestError } from "../../../utils/errors";
import { auditService } from "../../audit/services/audit.service";
import type { Prisma } from "@prisma/client";

export const LINEAS_SISTEMA_PROTEGIDAS = ["BOTA", "ACCESORIOS"];

export class TiposOperacionService {
  async getTiposOperacion(incluirInactivos = false) {
    return prisma.tipoOperacion.findMany({
      where: {
        eliminadoEn: null,
        ...(incluirInactivos ? {} : { estado: "ACTIVO" }),
      },
      include: {
        lineas: {
          where: { eliminadoEn: null },
          include: {
            departamentos: {
              where: { eliminadoEn: null, activo: true },
              include: {
                departamento: {
                  select: { id: true, codigo: true, nombre: true, estado: true },
                },
              },
            },
          },
        },
      },
      orderBy: { id: "asc" },
    });
  }

  async getTipoOperacionById(id: number) {
    const tipo = await prisma.tipoOperacion.findFirst({
      where: { id, eliminadoEn: null },
      include: {
        lineas: {
          where: { eliminadoEn: null },
          include: {
            departamentos: {
              where: { eliminadoEn: null },
              include: {
                departamento: {
                  select: { id: true, codigo: true, nombre: true, estado: true },
                },
              },
            },
          },
        },
      },
    });

    if (!tipo) {
      throw new NotFoundError("Tipo de operación no encontrado");
    }

    return tipo;
  }

  async createTipoOperacion(data: { codigo?: string; nombre: string; descripcion?: string | null }, usuarioId?: number) {
    let codigo = data.codigo?.trim().toUpperCase();

    if (!codigo) {
      // Generación automática a partir del nombre (sin acentos, mayúsculas, solo alfanuméricos)
      const base = data.nombre
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]/g, "_")
        .toUpperCase()
        .slice(0, 25);
      
      let candidate = base || "TIPO";
      let counter = 1;
      while (await prisma.tipoOperacion.findUnique({ where: { codigo: candidate } })) {
        candidate = `${base}_${counter}`.slice(0, 30);
        counter++;
      }
      codigo = candidate;
    } else {
      const existe = await prisma.tipoOperacion.findUnique({ where: { codigo } });
      if (existe) {
        throw new ConflictError(`El tipo de operación con código '${codigo}' ya existe`);
      }
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const nuevo = await tx.tipoOperacion.create({
        data: {
          codigo,
          nombre: data.nombre.trim(),
          descripcion: data.descripcion?.trim() || null,
          creadoPor: usuarioId,
        },
      });

      await auditService.registrarEvento({
        accion: "TIPO_OPERACION_CREADO",
        modulo: "CATALOGOS",
        entidad: "TipoOperacion",
        entidadId: nuevo.id.toString(),
        descripcion: `Creación del tipo de operación '${nuevo.nombre}' [${nuevo.codigo}]`,
        valoresPosteriores: nuevo as any,
        contexto: { usuarioId },
      }, tx);

      return nuevo;
    });
  }

  async updateTipoOperacion(id: number, data: { nombre?: string; descripcion?: string | null; estado?: "ACTIVO" | "INACTIVO" }, usuarioId?: number) {
    const actual = await this.getTipoOperacionById(id);

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const actualizado = await tx.tipoOperacion.update({
        where: { id },
        data: {
          ...data,
          actualizadoPor: usuarioId,
        },
      });

      await auditService.registrarEvento({
        accion: "TIPO_OPERACION_ACTUALIZADO",
        modulo: "CATALOGOS",
        entidad: "TipoOperacion",
        entidadId: id.toString(),
        descripcion: `Actualización del tipo de operación '${actualizado.nombre}'`,
        valoresAnteriores: actual as any,
        valoresPosteriores: actualizado as any,
        contexto: { usuarioId },
      }, tx);

      return actualizado;
    });
  }

  async deleteTipoOperacion(id: number, usuarioId?: number) {
    const actual = await this.getTipoOperacionById(id);

    const lineasActivas = await prisma.linea.count({
      where: { tipoOperacionId: id, eliminadoEn: null },
    });

    if (lineasActivas > 0) {
      throw new ConflictError("No se puede eliminar un tipo de operación con líneas activas asociadas");
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const eliminado = await tx.tipoOperacion.update({
        where: { id },
        data: {
          estado: "INACTIVO",
          eliminadoPor: usuarioId,
          eliminadoEn: new Date(),
        },
      });

      await auditService.registrarEvento({
        accion: "TIPO_OPERACION_ELIMINADO",
        modulo: "CATALOGOS",
        entidad: "TipoOperacion",
        entidadId: id.toString(),
        descripcion: `Borrado lógico del tipo de operación '${actual.nombre}'`,
        valoresAnteriores: actual as any,
        valoresPosteriores: eliminado as any,
        contexto: { usuarioId },
      }, tx);

      return { id, eliminado: true };
    });
  }

  // --- LÍNEAS ---
  async getLineas(tipoOperacionId?: number, incluirInactivas = false) {
    return prisma.linea.findMany({
      where: {
        eliminadoEn: null,
        ...(tipoOperacionId ? { tipoOperacionId } : {}),
        ...(incluirInactivas ? {} : { estado: "ACTIVO" }),
      },
      include: {
        tipoOperacion: { select: { id: true, codigo: true, nombre: true } },
        departamentos: {
          where: { eliminadoEn: null },
          orderBy: { orden: "asc" },
          include: {
            departamento: {
              select: { id: true, codigo: true, nombre: true, estado: true },
            },
          },
        },
      },
      orderBy: { id: "asc" },
    });
  }

  async getLineaById(id: number) {
    const linea = await prisma.linea.findFirst({
      where: { id, eliminadoEn: null },
      include: {
        tipoOperacion: true,
        departamentos: {
          where: { eliminadoEn: null },
          orderBy: { orden: "asc" },
          include: {
            departamento: true,
          },
        },
      },
    });

    if (!linea) {
      throw new NotFoundError("Línea no encontrada");
    }

    return linea;
  }

  async createLinea(data: { tipoOperacionId: number; codigo?: string; nombre: string; descripcion?: string | null }, usuarioId?: number) {
    const tipo = await prisma.tipoOperacion.findFirst({
      where: { id: data.tipoOperacionId, eliminadoEn: null },
    });
    if (!tipo) {
      throw new NotFoundError("El tipo de operación especificado no existe");
    }

    let codigo = data.codigo?.trim().toUpperCase();

    if (!codigo) {
      const base = data.nombre
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]/g, "_")
        .toUpperCase()
        .slice(0, 25);

      let candidate = base || "LINEA";
      let counter = 1;
      while (
        await prisma.linea.findUnique({
          where: {
            unique_tipo_linea_codigo: {
              tipoOperacionId: data.tipoOperacionId,
              codigo: candidate,
            },
          },
        })
      ) {
        candidate = `${base}_${counter}`.slice(0, 30);
        counter++;
      }
      codigo = candidate;
    } else {
      const existe = await prisma.linea.findUnique({
        where: {
          unique_tipo_linea_codigo: {
            tipoOperacionId: data.tipoOperacionId,
            codigo,
          },
        },
      });

      if (existe && !existe.eliminadoEn) {
        throw new ConflictError(`La línea con código '${codigo}' ya existe en este tipo de operación`);
      }
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const nueva = await tx.linea.create({
        data: {
          tipoOperacionId: data.tipoOperacionId,
          codigo,
          nombre: data.nombre.trim(),
          descripcion: data.descripcion?.trim() || null,
          creadoPor: usuarioId,
        },
      });

      await auditService.registrarEvento({
        accion: "LINEA_CREADA",
        modulo: "CATALOGOS",
        entidad: "Linea",
        entidadId: nueva.id.toString(),
        descripcion: `Creación de línea '${nueva.nombre}' [${nueva.codigo}]`,
        valoresPosteriores: nueva as any,
        contexto: { usuarioId },
      }, tx);

      return nueva;
    });
  }

  async updateLinea(id: number, data: { nombre?: string; descripcion?: string | null; estado?: "ACTIVO" | "INACTIVO" }, usuarioId?: number) {
    const actual = await this.getLineaById(id);

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const actualizada = await tx.linea.update({
        where: { id },
        data: {
          ...data,
          actualizadoPor: usuarioId,
        },
      });

      await auditService.registrarEvento({
        accion: "LINEA_ACTUALIZADA",
        modulo: "CATALOGOS",
        entidad: "Linea",
        entidadId: id.toString(),
        descripcion: `Actualización de línea '${actualizada.nombre}'`,
        valoresAnteriores: actual as any,
        valoresPosteriores: actualizada as any,
        contexto: { usuarioId },
      }, tx);

      return actualizada;
    });
  }

  async deleteLinea(id: number, usuarioId?: number) {
    const actual = await this.getLineaById(id);

    // 1. Protección de líneas maestras del sistema
    if (actual.codigo && LINEAS_SISTEMA_PROTEGIDAS.includes(actual.codigo.toUpperCase())) {
      throw new BadRequestError(
        `La línea '${actual.nombre}' es una línea maestra protegida del sistema y no puede eliminarse.`
      );
    }

    // 2. Protección contra departamentos huérfanos
    const deptosActivosCount = await prisma.departamentoLinea.count({
      where: {
        lineaId: id,
        activo: true,
        eliminadoEn: null,
        departamento: {
          eliminadoEn: null,
          estado: "ACTIVO",
        },
      },
    });

    if (deptosActivosCount > 0) {
      throw new BadRequestError(
        `No es posible eliminar la línea '${actual.nombre}' porque tiene ${deptosActivosCount} departamento(s) asignado(s). Primero debe reasignar o desvincular los departamentos para evitar dejarlos huérfanos.`
      );
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const eliminada = await tx.linea.update({
        where: { id },
        data: {
          estado: "INACTIVO",
          eliminadoPor: usuarioId,
          eliminadoEn: new Date(),
        },
      });

      await auditService.registrarEvento({
        accion: "LINEA_ELIMINADA",
        modulo: "CATALOGOS",
        entidad: "Linea",
        entidadId: id.toString(),
        descripcion: `Borrado lógico de línea '${actual.nombre}'`,
        valoresAnteriores: actual as any,
        valoresPosteriores: eliminada as any,
        contexto: { usuarioId },
      }, tx);

      return { id, eliminado: true };
    });
  }

  async syncLineaDepartamentos(
    lineaId: number,
    departamentos: Array<{ departamentoId: number; activo: boolean; orden?: number }>,
    usuarioId?: number
  ) {
    await this.getLineaById(lineaId);

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const resultados = [];

      for (const item of departamentos) {
        const asoc = await tx.departamentoLinea.upsert({
          where: {
            unique_depto_linea: {
              departamentoId: item.departamentoId,
              lineaId,
            },
          },
          update: {
            activo: item.activo,
            ...(item.orden !== undefined ? { orden: item.orden } : {}),
            actualizadoPor: usuarioId,
            eliminadoEn: null,
            eliminadoPor: null,
          },
          create: {
            lineaId,
            departamentoId: item.departamentoId,
            activo: item.activo,
            orden: item.orden ?? 0,
            creadoPor: usuarioId,
          },
        });
        resultados.push(asoc);
      }

      await auditService.registrarEvento({
        accion: "LINEA_DEPARTAMENTOS_SINCRONIZADOS",
        modulo: "CATALOGOS",
        entidad: "DepartamentoLinea",
        entidadId: lineaId.toString(),
        descripcion: `Actualización de departamentos asociados a línea #${lineaId}`,
        valoresPosteriores: { totalAsociaciones: resultados.length, departamentos },
        contexto: { usuarioId },
      }, tx);

      return resultados;
    });
  }
}

export const tiposOperacionService = new TiposOperacionService();

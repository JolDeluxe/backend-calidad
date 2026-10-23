import { prisma } from "../../../config/database";
import { NotFoundError, ConflictError, ForbiddenError } from "../../../utils/errors";
import { securityService } from "../../auth/services/security.service";
import { auditService } from "../../audit/services/audit.service";
import type { CreateUserInput, UpdateUserInput } from "../users.schema";

export class UsersService {
  async getUsers() {
    return prisma.usuario.findMany({
      select: {
        id: true,
        usuario: true,
        nombre: true,
        estado: true,
        fechaCreacion: true,
        rol: {
          select: { id: true, codigo: true, nombre: true },
        },
        departamentos: {
          where: { estado: "ACTIVO" },
          select: {
            departamento: { select: { id: true, codigo: true, nombre: true } },
          },
        },
      },
      orderBy: { id: "asc" },
    });
  }

  async getUserById(id: number) {
    const usuario = await prisma.usuario.findUnique({
      where: { id },
      select: {
        id: true,
        usuario: true,
        nombre: true,
        estado: true,
        fechaCreacion: true,
        rol: {
          select: { id: true, codigo: true, nombre: true },
        },
        departamentos: {
          where: { estado: "ACTIVO" },
          select: {
            departamento: { select: { id: true, codigo: true, nombre: true } },
          },
        },
      },
    });

    if (!usuario) {
      throw new NotFoundError("Usuario no encontrado");
    }

    return usuario;
  }

  async createUser(input: CreateUserInput, actorId?: number) {
    const existente = await prisma.usuario.findUnique({
      where: { usuario: input.usuario },
    });

    if (existente) {
      throw new ConflictError("El nombre de usuario ya está registrado");
    }

    const passwordHash = securityService.hashPassword(input.password);

    // Transacción atómica: Creación de usuario y registro de auditoría encadenada
    return await prisma.$transaction(async (tx) => {
      const nuevoUsuario = await tx.usuario.create({
        data: {
          usuario: input.usuario,
          nombre: input.nombre,
          passwordHash,
          rolId: input.rolId,
          estado: "ACTIVO",
        },
        select: {
          id: true,
          usuario: true,
          nombre: true,
          estado: true,
          rol: {
            select: { id: true, codigo: true, nombre: true },
          },
        },
      });

      // Registrar auditoría centralizada con hash en la misma transacción
      await auditService.registrarEvento(
        {
          accion: "USUARIO_CREADO",
          modulo: "USUARIOS",
          entidad: "usuario",
          entidadId: String(nuevoUsuario.id),
          descripcion: `Usuario '${nuevoUsuario.usuario}' creado con rol '${nuevoUsuario.rol.codigo}'`,
          valoresAnteriores: null,
          valoresPosteriores: {
            usuario: nuevoUsuario.usuario,
            nombre: nuevoUsuario.nombre,
            rolId: nuevoUsuario.rol.id,
            rolCodigo: nuevoUsuario.rol.codigo,
            estado: nuevoUsuario.estado,
          },
          contexto: {
            usuarioId: actorId,
          },
        },
        tx
      );

      return nuevoUsuario;
    });
  }

  async updateUser(id: number, input: UpdateUserInput, actorId?: number) {
    const usuarioExistente = await prisma.usuario.findUnique({
      where: { id },
      include: { rol: true },
    });

    if (!usuarioExistente) {
      throw new NotFoundError("Usuario no encontrado");
    }

    // Regla de seguridad: Protección del último SUPER_ADMIN activo
    if (usuarioExistente.rol.codigo === "SUPER_ADMIN") {
      const intentoDegradar = input.rolId && input.rolId !== usuarioExistente.rolId;
      const intentoDesactivar = input.estado === "INACTIVO";

      if (intentoDegradar || intentoDesactivar) {
        const superAdminsActivos = await prisma.usuario.count({
          where: {
            rol: { codigo: "SUPER_ADMIN" },
            estado: "ACTIVO",
          },
        });

        if (superAdminsActivos <= 1) {
          throw new ForbiddenError("Operación denegada: no se puede degradar ni desactivar al último SUPER_ADMIN activo");
        }
      }
    }

    // Transacción atómica: Actualización, revocación de sesiones (si inactivo) y registro de auditoría encadenada
    return await prisma.$transaction(async (tx) => {
      const actualizado = await tx.usuario.update({
        where: { id },
        data: {
          ...(input.nombre && { nombre: input.nombre }),
          ...(input.rolId && { rolId: input.rolId }),
          ...(input.estado && { estado: input.estado }),
        },
        select: {
          id: true,
          usuario: true,
          nombre: true,
          estado: true,
          rol: {
            select: { id: true, codigo: true, nombre: true },
          },
        },
      });

      // Si el usuario fue desactivado, revocar de inmediato sus sesiones activas
      if (input.estado === "INACTIVO") {
        await tx.sesion.updateMany({
          where: { usuarioId: id, estado: "ACTIVO" },
          data: { estado: "INACTIVO" },
        });
      }

      // Registrar auditoría centralizada con hash en la misma transacción
      const accion = input.estado === "INACTIVO" ? "USUARIO_DESACTIVADO" : "USUARIO_ACTUALIZADO";
      await auditService.registrarEvento(
        {
          accion,
          modulo: "USUARIOS",
          entidad: "usuario",
          entidadId: String(id),
          descripcion: `Usuario '${usuarioExistente.usuario}' modificado (${accion})`,
          valoresAnteriores: {
            nombre: usuarioExistente.nombre,
            rolId: usuarioExistente.rolId,
            estado: usuarioExistente.estado,
          },
          valoresPosteriores: {
            nombre: actualizado.nombre,
            rolId: actualizado.rol.id,
            estado: actualizado.estado,
          },
          contexto: {
            usuarioId: actorId,
          },
        },
        tx
      );

      return actualizado;
    });
  }

  async deleteUser(id: number, actorId?: number) {
    return this.updateUser(id, { estado: "INACTIVO" }, actorId);
  }

  async getRoles() {
    return prisma.rol.findMany({
      where: { estado: "ACTIVO" },
      select: { id: true, codigo: true, nombre: true, esSistema: true },
    });
  }
}

export const usersService = new UsersService();

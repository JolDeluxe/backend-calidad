import { prisma } from "../../../config/database";
import { NotFoundError, ConflictError, ForbiddenError } from "../../../utils/errors";
import { securityService } from "../../auth/services/security.service";
import { auditService } from "../../audit/services/audit.service";
import { generarUsernameUnico } from "../utils/username-generator";
import type { CreateUserInput, UpdateUserInput } from "../users.schema";

export class UsersService {
  async getUsers(actorRol?: string) {
    const usuarios = await prisma.usuario.findMany({
      select: {
        id: true,
        usuario: true,
        nombre: true,
        estado: true,
        passwordHash: true,
        fechaCreacion: true,
        rol: {
          select: { id: true, codigo: true, nombre: true },
        },
      },
      orderBy: { id: "asc" },
    });

    const jerarquiaRoles: Record<string, number> = {
      SUPER_ADMIN: 1,
      ADMIN: 2,
      COORD: 3,
      INSPECTOR: 4,
      VISUALIZADOR: 5,
    };

    // Desencriptar contraseñas para administradores (SUPER_ADMIN / ADMIN)
    const procesados = usuarios.map((u) => {
      let passwordClara = "";
      if (actorRol === "SUPER_ADMIN" || actorRol === "ADMIN") {
        passwordClara = securityService.decryptPassword(u.passwordHash) || "••••••";
      }
      const { passwordHash: _, ...resto } = u;
      return {
        ...resto,
        password: passwordClara,
      };
    });

    return procesados.sort((a, b) => {
      const ordenA = jerarquiaRoles[a.rol.codigo] || 99;
      const ordenB = jerarquiaRoles[b.rol.codigo] || 99;
      if (ordenA !== ordenB) return ordenA - ordenB;
      return a.nombre.localeCompare(b.nombre);
    });
  }

  async getUserById(id: number, actorRol?: string) {
    const usuario = await prisma.usuario.findUnique({
      where: { id },
      select: {
        id: true,
        usuario: true,
        nombre: true,
        estado: true,
        passwordHash: true,
        fechaCreacion: true,
        rol: {
          select: { id: true, codigo: true, nombre: true },
        },
      },
    });

    if (!usuario) {
      throw new NotFoundError("Usuario no encontrado");
    }

    let passwordClara = "";
    if (actorRol === "SUPER_ADMIN" || actorRol === "ADMIN") {
      passwordClara = securityService.decryptPassword(usuario.passwordHash) || "••••••";
    }

    const { passwordHash: _, ...resto } = usuario;
    return {
      ...resto,
      password: passwordClara,
    };
  }

  async suggestUsername(nombre: string, excludeId?: number): Promise<{ username: string }> {
    const username = await generarUsernameUnico(nombre, excludeId);
    return { username };
  }

  async createUser(input: CreateUserInput, actorId?: number, actorRol?: string) {
    // Regla de jerarquía: Solo un SUPER_ADMIN puede crear a otro SUPER_ADMIN
    const rolDeseado = await prisma.rol.findUnique({
      where: { id: input.rolId },
    });

    if (!rolDeseado || rolDeseado.estado !== "ACTIVO") {
      throw new NotFoundError("El rol seleccionado no es válido o está inactivo");
    }

    if (rolDeseado.codigo === "SUPER_ADMIN" && actorRol !== "SUPER_ADMIN") {
      throw new ForbiddenError("Solo un Super Administrador puede crear o asignar usuarios con rol Super Administrador");
    }

    if (rolDeseado.codigo === "VISUALIZADOR" && actorRol !== "SUPER_ADMIN") {
      throw new ForbiddenError("Solo un Super Administrador puede registrar o asignar usuarios con rol Visualizador");
    }

    // Generar username único a partir del nombre completo
    const usernameGenerado = await generarUsernameUnico(input.nombre);

    const passwordHash = securityService.encryptPassword(input.password);

    // Transacción atómica: Creación de usuario y registro de auditoría encadenada
    return await prisma.$transaction(async (tx) => {
      const nuevoUsuario = await tx.usuario.create({
        data: {
          usuario: usernameGenerado,
          nombre: input.nombre.trim(),
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

      return {
        ...nuevoUsuario,
        password: input.password,
      };
    });
  }

  async updateUser(id: number, input: UpdateUserInput, actorId?: number, actorRol?: string) {
    const usuarioExistente = await prisma.usuario.findUnique({
      where: { id },
      include: { rol: true },
    });

    if (!usuarioExistente) {
      throw new NotFoundError("Usuario no encontrado");
    }

    // Regla de jerarquía: Solo un SUPER_ADMIN puede degradar/modificar a un SUPER_ADMIN
    if (usuarioExistente.rol.codigo === "SUPER_ADMIN" && actorRol !== "SUPER_ADMIN") {
      throw new ForbiddenError("Solo un Super Administrador puede modificar a un usuario con rol Super Administrador");
    }

    // Si se intenta asignar el rol SUPER_ADMIN o VISUALIZADOR, quien ejecuta debe ser SUPER_ADMIN
    if (input.rolId && input.rolId !== usuarioExistente.rolId) {
      const nuevoRol = await prisma.rol.findUnique({ where: { id: input.rolId } });
      if (nuevoRol?.codigo === "SUPER_ADMIN" && actorRol !== "SUPER_ADMIN") {
        throw new ForbiddenError("Solo un Super Administrador puede ascender usuarios a Super Administrador");
      }
      if (nuevoRol?.codigo === "VISUALIZADOR" && actorRol !== "SUPER_ADMIN") {
        throw new ForbiddenError("Solo un Super Administrador puede asignar el rol Visualizador");
      }
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

    // Si se modifica el nombre, sincronizar automáticamente el username sin romper unicidad
    let nuevoUsername = usuarioExistente.usuario;
    if (input.nombre && input.nombre.trim() !== usuarioExistente.nombre) {
      nuevoUsername = await generarUsernameUnico(input.nombre, id);
    }

    // Cifrar nueva contraseña si fue provista
    const nuevoPasswordHash = input.password
      ? securityService.encryptPassword(input.password)
      : undefined;

    // Transacción atómica: Actualización y registro de auditoría encadenada
    // NOTA: Si el usuario NO fue desactivado, sus sesiones activas SE PRESERVAN INTACTAS
    return await prisma.$transaction(async (tx) => {
      const actualizado = await tx.usuario.update({
        where: { id },
        data: {
          ...(input.nombre && { nombre: input.nombre.trim() }),
          usuario: nuevoUsername,
          ...(nuevoPasswordHash && { passwordHash: nuevoPasswordHash }),
          ...(input.rolId && { rolId: input.rolId }),
          ...(input.estado && { estado: input.estado }),
        },
        select: {
          id: true,
          usuario: true,
          nombre: true,
          estado: true,
          passwordHash: true,
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
            usuario: usuarioExistente.usuario,
            nombre: usuarioExistente.nombre,
            rolId: usuarioExistente.rolId,
            estado: usuarioExistente.estado,
          },
          valoresPosteriores: {
            usuario: actualizado.usuario,
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

      let passwordClara = "";
      if (actorRol === "SUPER_ADMIN" || actorRol === "ADMIN") {
        passwordClara = securityService.decryptPassword(actualizado.passwordHash) || "••••••";
      }

      const { passwordHash: _, ...resto } = actualizado;
      return {
        ...resto,
        password: passwordClara,
      };
    });
  }

  async deleteUser(id: number, actorId?: number, actorRol?: string) {
    return this.updateUser(id, { estado: "INACTIVO" }, actorId, actorRol);
  }

  async getRoles(actorRol?: string) {
    // Si quien consulta no es SUPER_ADMIN, no ofrecer ni SUPER_ADMIN ni VISUALIZADOR
    const excluidos: string[] = ["USUARIO"];
    if (actorRol !== "SUPER_ADMIN") {
      excluidos.push("SUPER_ADMIN", "VISUALIZADOR");
    }

    const roles = await prisma.rol.findMany({
      where: {
        estado: "ACTIVO",
        codigo: { notIn: excluidos },
      },
      select: { id: true, codigo: true, nombre: true, esSistema: true },
      orderBy: { id: "asc" },
    });

    const ordenRoles: Record<string, number> = {
      SUPER_ADMIN: 1,
      ADMIN: 2,
      COORD: 3,
      INSPECTOR: 4,
      VISUALIZADOR: 5,
    };

    return roles.sort((a, b) => (ordenRoles[a.codigo] || 99) - (ordenRoles[b.codigo] || 99));
  }
}

export const usersService = new UsersService();

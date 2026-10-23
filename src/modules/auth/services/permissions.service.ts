import { prisma } from "../../../config/database";

export interface PermisosEfectivos {
  usuarioId: number;
  rolCodigo: string;
  permisos: string[];
  departamentosIds: number[];
}

export class PermissionsService {
  /**
   * Resuelve los permisos efectivos de un usuario aplicando la regla estricta:
   * 1. Usuario inactivo -> sin permisos.
   * 2. Permisos activos heredados del rol activo.
   * 3. Excepciones vigentes (CONCEDER suma, DENEGAR prevalece sobre concesión heredada).
   * 4. Departamentos autorizados activos asignados al usuario.
   */
  async getPermisosEfectivos(usuarioId: number): Promise<PermisosEfectivos> {
    const usuario = await prisma.usuario.findUnique({
      where: { id: usuarioId },
      include: {
        rol: {
          include: {
            permisos: {
              where: { estado: "ACTIVO", permiso: { estado: "ACTIVO" } },
              include: { permiso: true },
            },
          },
        },
        departamentos: {
          where: { estado: "ACTIVO", departamento: { estado: "ACTIVO" } },
          include: { departamento: true },
        },
        excepcionesPermiso: {
          where: {
            permiso: { estado: "ACTIVO" },
            OR: [
              { fechaVencimiento: null },
              { fechaVencimiento: { gt: new Date() } },
            ],
          },
          include: { permiso: true },
        },
      },
    });

    if (!usuario || usuario.estado !== "ACTIVO" || usuario.rol.estado !== "ACTIVO") {
      return {
        usuarioId,
        rolCodigo: usuario?.rol?.codigo || "",
        permisos: [],
        departamentosIds: [],
      };
    }

    // 1. Permisos del rol
    const permisosSet = new Set<string>();
    for (const rp of usuario.rol.permisos) {
      permisosSet.add(rp.permiso.codigo);
    }

    // 2. Aplicar excepciones individuales
    for (const excepcion of usuario.excepcionesPermiso) {
      if (excepcion.accion === "CONCEDER") {
        permisosSet.add(excepcion.permiso.codigo);
      } else if (excepcion.accion === "DENEGAR") {
        permisosSet.delete(excepcion.permiso.codigo);
      }
    }

    const departamentosIds = usuario.departamentos.map((d) => d.departamentoId);

    return {
      usuarioId: usuario.id,
      rolCodigo: usuario.rol.codigo,
      permisos: Array.from(permisosSet),
      departamentosIds,
    };
  }

  /**
   * Verifica si el usuario tiene un permiso específico considerando excepciones
   */
  async hasPermission(usuarioId: number, permisoCodigo: string): Promise<boolean> {
    const efectivos = await this.getPermisosEfectivos(usuarioId);
    return efectivos.permisos.includes(permisoCodigo);
  }

  /**
   * Verifica si el usuario tiene alcance sobre un departamento específico
   */
  async hasDepartmentScope(usuarioId: number, departamentoId: number): Promise<boolean> {
    const efectivos = await this.getPermisosEfectivos(usuarioId);
    // SUPER_ADMIN tiene alcance global
    if (efectivos.rolCodigo === "SUPER_ADMIN") {
      return true;
    }
    return efectivos.departamentosIds.includes(departamentoId);
  }
}

export const permissionsService = new PermissionsService();

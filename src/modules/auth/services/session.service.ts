import { prisma } from "../../../config/database";
import { UnauthorizedError } from "../../../utils/errors";
import { securityService, type TokenPayload } from "./security.service";
import { auditService } from "../../audit/services/audit.service";
import { env } from "../../../config/env";
import type { LoginInput } from "../auth.schema";

export interface LoginResult {
  usuario: {
    id: number;
    usuario: string;
    nombre: string;
    rol: {
      id: number;
      codigo: string;
      nombre: string;
    };
  };
  accessToken: string;
  refreshToken: string;
}

export interface RefreshResult {
  usuario: {
    id: number;
    usuario: string;
    nombre: string;
    rol: {
      id: number;
      codigo: string;
      nombre: string;
    };
  };
  accessToken: string;
  sessionExtended?: boolean;
}

export class SessionService {
  async login(input: LoginInput, ipOrigen?: string, agenteUsuario?: string): Promise<LoginResult> {
    const usuario = await prisma.usuario.findFirst({
      where: {
        OR: [{ usuario: input.usuario }, { nombre: input.usuario }],
        estado: "ACTIVO",
      },
      include: { rol: true },
    });

    if (!usuario || usuario.estado !== "ACTIVO") {
      // Registrar intento fallido en auditoría sin revelar si la cuenta existe o no
      try {
        await auditService.registrarEvento({
          accion: "LOGIN_FALLIDO",
          modulo: "AUTENTICACION",
          entidad: "sesion",
          descripcion: `Intento de inicio de sesión fallido para identificador provisto: '${input.usuario.slice(0, 30)}'`,
          resultado: "RECHAZADO",
          motivo: "Credenciales inválidas o usuario inactivo",
          contexto: {
            ipOrigen,
            agenteUsuario,
          },
        });
      } catch (e) {
        // La falla en auditoría de un intento fallido no debe enmascarar el rechazo
      }
      throw new UnauthorizedError("Credenciales inválidas o usuario inactivo");
    }

    const isValidPassword = securityService.verifyPassword(input.password, usuario.passwordHash);
    if (!isValidPassword) {
      try {
        await auditService.registrarEvento({
          accion: "LOGIN_FALLIDO",
          modulo: "AUTENTICACION",
          entidad: "sesion",
          descripcion: `Contraseña incorrecta para usuario '${usuario.usuario}'`,
          resultado: "RECHAZADO",
          motivo: "Contraseña inválida",
          contexto: {
            usuarioId: usuario.id,
            usuarioNombre: usuario.usuario,
            rolCodigo: usuario.rol.codigo,
            ipOrigen,
            agenteUsuario,
          },
        });
      } catch (e) {}
      throw new UnauthorizedError("Credenciales inválidas o usuario inactivo");
    }

    const refreshToken = securityService.generateRefreshToken();
    const refreshTokenHash = securityService.hashRefreshToken(refreshToken);

    const now = new Date();
    const fechaExpiracion = new Date(now.getTime() + env.SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000);

    // Transacción atómica: Crear sesión y registrar auditoría encadenada de LOGIN_EXITOSO
    const sesionCreada = await prisma.$transaction(async (tx) => {
      const sesion = await tx.sesion.create({
        data: {
          usuarioId: usuario.id,
          refreshTokenHash,
          estado: "ACTIVO",
          fechaExpiracion,
          fechaUltimoUso: now,
          fechaUltimaExtension: now,
          ipOrigen: ipOrigen?.slice(0, 45),
          agenteUsuario: agenteUsuario?.slice(0, 255),
        },
      });

      await auditService.registrarEvento(
        {
          accion: "LOGIN_EXITOSO",
          modulo: "AUTENTICACION",
          entidad: "sesion",
          entidadId: String(sesion.id),
          descripcion: `Inicio de sesión exitoso del usuario '${usuario.usuario}' [Rol: ${usuario.rol.codigo}]`,
          resultado: "EXITOSO",
          valoresAnteriores: null,
          valoresPosteriores: {
            sesionId: sesion.id,
            usuarioId: usuario.id,
            usuario: usuario.usuario,
            rol: usuario.rol.codigo,
            fechaExpiracion: sesion.fechaExpiracion,
          },
          contexto: {
            usuarioId: usuario.id,
            usuarioNombre: usuario.usuario,
            rolCodigo: usuario.rol.codigo,
            ipOrigen,
            agenteUsuario,
          },
        },
        tx
      );

      return sesion;
    });

    const tokenPayload: TokenPayload = {
      usuarioId: usuario.id,
      usuario: usuario.usuario,
      nombre: usuario.nombre,
      rolId: usuario.rol.id,
      rolCodigo: usuario.rol.codigo,
      sesionId: sesionCreada.id,
    };

    const accessToken = securityService.generateAccessToken(tokenPayload);

    return {
      usuario: {
        id: usuario.id,
        usuario: usuario.usuario,
        nombre: usuario.nombre,
        rol: {
          id: usuario.rol.id,
          codigo: usuario.rol.codigo,
          nombre: usuario.rol.nombre,
        },
      },
      accessToken,
      refreshToken,
    };
  }

  async refresh(refreshToken?: string): Promise<RefreshResult> {
    if (!refreshToken) {
      throw new UnauthorizedError("No se proporcionó token de sesión");
    }

    const refreshTokenHash = securityService.hashRefreshToken(refreshToken);

    const sesion = await prisma.sesion.findUnique({
      where: { refreshTokenHash },
      include: {
        usuario: {
          include: { rol: true },
        },
      },
    });

    if (!sesion || sesion.estado !== "ACTIVO" || sesion.fechaExpiracion < new Date()) {
      throw new UnauthorizedError("Sesión expirada o inválida");
    }

    if (sesion.usuario.estado !== "ACTIVO") {
      throw new UnauthorizedError("El usuario se encuentra inactivo");
    }

    const now = new Date();
    // Renovación deslizante desacoplada de fechaUltimoUso
    const veinticuatroHorasMs = 24 * 60 * 60 * 1000;
    const referenciaExtension = sesion.fechaUltimaExtension || sesion.fechaCreacion;
    const tiempoDesdeUltimaExtension = now.getTime() - referenciaExtension.getTime();
    const shouldExtendExpiration = tiempoDesdeUltimaExtension >= veinticuatroHorasMs;

    const nuevaFechaExpiracion = shouldExtendExpiration
      ? new Date(now.getTime() + env.SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000)
      : sesion.fechaExpiracion;

    const dataToUpdate: {
      fechaUltimoUso: Date;
      fechaExpiracion?: Date;
      fechaUltimaExtension?: Date;
    } = {
      fechaUltimoUso: now,
    };

    if (shouldExtendExpiration) {
      dataToUpdate.fechaExpiracion = nuevaFechaExpiracion;
      dataToUpdate.fechaUltimaExtension = now;
    }

    await prisma.sesion.update({
      where: { id: sesion.id },
      data: dataToUpdate,
    });

    // Si hubo extensión efectiva de 24 horas, registrar evento de auditoría
    if (shouldExtendExpiration) {
      try {
        await auditService.registrarEvento({
          accion: "SESION_EXTENDIDA_SLIDING",
          modulo: "AUTENTICACION",
          entidad: "sesion",
          entidadId: String(sesion.id),
          descripcion: `Sesión #${sesion.id} del usuario '${sesion.usuario.usuario}' extendida 10 años por renovación deslizante diaria`,
          valoresAnteriores: { fechaExpiracion: sesion.fechaExpiracion },
          valoresPosteriores: { fechaExpiracion: nuevaFechaExpiracion },
          contexto: {
            usuarioId: sesion.usuario.id,
            usuarioNombre: sesion.usuario.usuario,
            rolCodigo: sesion.usuario.rol.codigo,
          },
        });
      } catch (e) {}
    }

    const tokenPayload: TokenPayload = {
      usuarioId: sesion.usuario.id,
      usuario: sesion.usuario.usuario,
      nombre: sesion.usuario.nombre,
      rolId: sesion.usuario.rol.id,
      rolCodigo: sesion.usuario.rol.codigo,
      sesionId: sesion.id,
    };

    const accessToken = securityService.generateAccessToken(tokenPayload);

    return {
      usuario: {
        id: sesion.usuario.id,
        usuario: sesion.usuario.usuario,
        nombre: sesion.usuario.nombre,
        rol: {
          id: sesion.usuario.rol.id,
          codigo: sesion.usuario.rol.codigo,
          nombre: sesion.usuario.rol.nombre,
        },
      },
      accessToken,
      sessionExtended: shouldExtendExpiration,
    };
  }

  async logout(refreshToken?: string): Promise<{ cerrado: boolean }> {
    if (!refreshToken) {
      return { cerrado: true };
    }

    const refreshTokenHash = securityService.hashRefreshToken(refreshToken);

    const sesion = await prisma.sesion.findUnique({
      where: { refreshTokenHash },
      include: { usuario: { include: { rol: true } } },
    });

    if (sesion) {
      await prisma.$transaction(async (tx) => {
        await tx.sesion.update({
          where: { id: sesion.id },
          data: { estado: "INACTIVO" },
        });

        await auditService.registrarEvento(
          {
            accion: "LOGOUT",
            modulo: "AUTENTICACION",
            entidad: "sesion",
            entidadId: String(sesion.id),
            descripcion: `Cierre de sesión voluntario del usuario '${sesion.usuario.usuario}'`,
            contexto: {
              usuarioId: sesion.usuario.id,
              usuarioNombre: sesion.usuario.usuario,
              rolCodigo: sesion.usuario.rol.codigo,
            },
          },
          tx
        );
      });
    }

    return { cerrado: true };
  }

  async validateActiveUser(usuarioId: number) {
    const usuario = await prisma.usuario.findUnique({
      where: { id: usuarioId },
      include: { rol: true },
    });

    if (!usuario || usuario.estado !== "ACTIVO") {
      throw new UnauthorizedError("Usuario inactivo o inexistente");
    }

    return usuario;
  }

  async validateActiveSession(sesionId: number) {
    const sesion = await prisma.sesion.findUnique({
      where: { id: sesionId },
    });

    if (!sesion || sesion.estado !== "ACTIVO" || sesion.fechaExpiracion < new Date()) {
      throw new UnauthorizedError("Sesión revocada o expirada");
    }

    return sesion;
  }

  /**
   * Canjea un token offline firmado legítimo (emitido dentro de las 48h anteriores)
   * por una sesión online completa en MySQL con cookie de sesión y accessToken.
   * Exige que la estación física vinculada esté activa.
   */
  async exchangeOfflineToken(
    usuarioId: number,
    terminalId: number,
    ipOrigen?: string,
    agenteUsuario?: string,
  ): Promise<LoginResult> {
    const usuario = await prisma.usuario.findUnique({
      where: { id: usuarioId },
      include: { rol: true },
    });

    if (!usuario || usuario.estado !== "ACTIVO") {
      throw new UnauthorizedError("El usuario de la autorización offline se encuentra inactivo");
    }

    const refreshToken = securityService.generateRefreshToken();
    const refreshTokenHash = securityService.hashRefreshToken(refreshToken);

    const now = new Date();
    const fechaExpiracion = new Date(now.getTime() + env.SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000);

    const sesionCreada = await prisma.$transaction(async (tx) => {
      const sesion = await tx.sesion.create({
        data: {
          usuarioId: usuario.id,
          refreshTokenHash,
          estado: "ACTIVO",
          fechaExpiracion,
          fechaUltimoUso: now,
          fechaUltimaExtension: now,
          ipOrigen: ipOrigen?.slice(0, 45),
          agenteUsuario: agenteUsuario?.slice(0, 255),
        },
      });

      await auditService.registrarEvento(
        {
          accion: "LOGIN_RECONEXION_OFFLINE",
          modulo: "AUTENTICACION_OFFLINE",
          entidad: "sesion",
          entidadId: String(sesion.id),
          descripcion: `Transición automática a sesión online para inspector '${usuario.usuario}' en terminal #${terminalId} al recuperar conectividad`,
          resultado: "EXITOSO",
          valoresPosteriores: {
            sesionId: sesion.id,
            usuarioId: usuario.id,
            usuario: usuario.usuario,
            terminalId,
            fechaExpiracion: sesion.fechaExpiracion,
          },
          contexto: {
            usuarioId: usuario.id,
            usuarioNombre: usuario.usuario,
            rolCodigo: usuario.rol.codigo,
            terminalId,
            ipOrigen,
            agenteUsuario,
          },
        },
        tx
      );

      return sesion;
    });

    const tokenPayload: TokenPayload = {
      usuarioId: usuario.id,
      usuario: usuario.usuario,
      nombre: usuario.nombre,
      rolId: usuario.rol.id,
      rolCodigo: usuario.rol.codigo,
      sesionId: sesionCreada.id,
    };

    const accessToken = securityService.generateAccessToken(tokenPayload);

    return {
      usuario: {
        id: usuario.id,
        usuario: usuario.usuario,
        nombre: usuario.nombre,
        rol: {
          id: usuario.rol.id,
          codigo: usuario.rol.codigo,
          nombre: usuario.rol.nombre,
        },
      },
      accessToken,
      refreshToken,
    };
  }
}

export const sessionService = new SessionService();

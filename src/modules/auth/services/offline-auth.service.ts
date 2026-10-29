import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../../../config/env";
import { prisma } from "../../../config/database";
import { UnauthorizedError } from "../../../utils/errors";
import { securityService } from "./security.service";
import { permissionsService } from "./permissions.service";

export interface OfflineTokenPayload {
  sub: number;             // usuarioId del inspector
  usuario: string;         // username
  nombre: string;          // nombre del inspector
  terminalId: number;      // terminal física validada
  terminalNombre: string;  // nombre de terminal
  departamentoId: number;  // departamento auditor asignado a la terminal
  tipo: "OFFLINE_CAPTURE";
  iat: number;             // segundos UTC
  exp: number;             // segundos UTC (exactamente 172,800 segundos = 48 horas tras emisión)
}

export interface VerifyOfflineTokenOptions {
  /**
   * Si es true, permite validar un token cuya firma HMAC-SHA256 es auténtica aunque `exp < now`.
   * Esto se utiliza durante la sincronización diferida para distinguir una captura firmada
   * legítimamente antes del vencimiento frente a un token manipulado o corrupto.
   */
  allowExpiredForSync?: boolean;
}

export interface VerifiedOfflineTokenResult {
  payload: OfflineTokenPayload;
  expired: boolean;
}

export interface InspectorOfflineItem {
  inspectorId: number;
  usuario: string;
  nombre: string;
  rolCodigo: string;
  activo: boolean;
  permisos: string[];
  saltOffline: string;
  verifierOffline: string;
  iteracionesPbkdf2: number;
  offlineToken: string;
  emitidoEn: number;
  expiraEn: number;
  vigenciaSegundos: number;
}

export class OfflineAuthService {
  /**
   * Vigencia de la credencial offline: 48 horas exactas (172,800 segundos).
   */
  public readonly VIGENCIA_SEGUNDOS = 172800;

  /**
   * Iteraciones PBKDF2-HMAC-SHA256 para el verificador unidireccional de contraseña offline.
   */
  public readonly PBKDF2_ITERATIONS = 100000;
  public readonly PBKDF2_KEYLEN = 32;

  /**
   * Almacén de salts aleatorios para cuentas cuyo passwordHash aún no tenía el sufijo de salt
   * persistido o cuando la base de datos no pudo actualizarse en el acto.
   * La clave es `${usuarioId}:${passwordHash}` para garantizar que si la contraseña cambia,
   * el salt anterior queda inmediatamente invalidado.
   */
  private readonly fallbackRandomSalts = new Map<string, string>();

  /**
   * Emite un token HMAC-SHA256 específico para autorización de capturas offline.
   * La firma utiliza JWT_SECRET y la vigencia es de 48 horas (172,800 segundos) calculada con el reloj del servidor.
   */
  generateOfflineToken(params: {
    usuarioId: number;
    usuario: string;
    nombre: string;
    terminalId: number;
    terminalNombre: string;
    departamentoId: number;
    issuedAtSec?: number;
  }): { token: string; emitidoEn: number; expiraEn: number; vigenciaSegundos: number } {
    const now = params.issuedAtSec ?? Math.floor(Date.now() / 1000);
    const exp = now + this.VIGENCIA_SEGUNDOS;

    const payload: OfflineTokenPayload = {
      sub: params.usuarioId,
      usuario: params.usuario,
      nombre: params.nombre,
      terminalId: params.terminalId,
      terminalNombre: params.terminalNombre,
      departamentoId: params.departamentoId,
      tipo: "OFFLINE_CAPTURE",
      iat: now,
      exp,
    };

    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT-OFFLINE" })).toString("base64url");
    const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", env.JWT_SECRET)
      .update(`${header}.${payloadEncoded}`)
      .digest("base64url");

    return {
      token: `${header}.${payloadEncoded}.${signature}`,
      emitidoEn: now,
      expiraEn: exp,
      vigenciaSegundos: this.VIGENCIA_SEGUNDOS,
    };
  }

  /**
   * Valida la firma matemática, vigencia y estructura del token offline.
   * Lanza UnauthorizedError si no es válido o ha expirado.
   */
  verifyOfflineToken(token: string): OfflineTokenPayload {
    const result = this.verifyOfflineTokenDetailed(token, { allowExpiredForSync: false });
    return result.payload;
  }

  /**
   * Valida la firma matemática (con comparación en tiempo constante) y estructura del token offline,
   * devolviendo además si el token se encuentra expirado respecto al reloj actual del servidor.
   */
  verifyOfflineTokenDetailed(
    token: string,
    options: VerifyOfflineTokenOptions = {},
  ): VerifiedOfflineTokenResult {
    if (!token || typeof token !== "string") {
      throw new UnauthorizedError("Token offline no proporcionado");
    }

    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new UnauthorizedError("Formato de token offline inválido");
    }

    const [headerB64, payloadB64, signature] = parts;
    if (!headerB64 || !payloadB64 || !signature) {
      throw new UnauthorizedError("Formato de token offline inválido");
    }

    const expectedSignature = createHmac("sha256", env.JWT_SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");

    const sigBuf = Buffer.from(signature, "utf8");
    const expectedBuf = Buffer.from(expectedSignature, "utf8");
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      throw new UnauthorizedError("Firma del token offline inválida o alterada");
    }

    let payload: OfflineTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    } catch {
      throw new UnauthorizedError("Cuerpo de token offline corrupto");
    }

    if (
      payload.tipo !== "OFFLINE_CAPTURE" ||
      typeof payload.sub !== "number" ||
      typeof payload.terminalId !== "number" ||
      typeof payload.departamentoId !== "number" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      throw new UnauthorizedError("Estructura de token offline inválida");
    }

    const now = Math.floor(Date.now() / 1000);
    const expired = payload.exp < now;

    if (expired && !options.allowExpiredForSync) {
      throw new UnauthorizedError("El token de captura offline ha expirado (límite de 48 horas superado)");
    }

    return { payload, expired };
  }

  /**
   * Deriva el verificador unidireccional PBKDF2-HMAC-SHA256 para autenticación offline en el navegador.
   */
  deriveOfflineVerifier(password: string, saltHex: string): string {
    const saltBuffer = Buffer.from(saltHex, "hex");
    return pbkdf2Sync(
      Buffer.from(password, "utf8"),
      saltBuffer,
      this.PBKDF2_ITERATIONS,
      this.PBKDF2_KEYLEN,
      "sha256",
    ).toString("hex");
  }

  /**
   * Verifica una contraseña en texto plano contra un verificador PBKDF2-HMAC-SHA256 usando comparación en tiempo constante.
   */
  verifyOfflineVerifier(password: string, saltHex: string, expectedVerifierHex: string): boolean {
    try {
      const derivedHex = this.deriveOfflineVerifier(password, saltHex);
      const a = Buffer.from(derivedHex, "hex");
      const b = Buffer.from(expectedVerifierHex, "hex");
      if (a.length === 0 || a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /**
   * Obtiene o genera y persiste un salt aleatorio criptográfico único (16 bytes = 32 chars hex)
   * asociado al usuario y versión de su credencial.
   * Si la contraseña cambia (`encryptPassword`), se genera un nuevo salt aleatorio automáticamente.
   */
  async resolveOrPersistRandomSalt(usuarioId: number, storedPasswordHash: string): Promise<string> {
    if (storedPasswordHash.startsWith("enc:v1:")) {
      const payload = storedPasswordHash.slice("enc:v1:".length);
      const parts = payload.split(":");
      if (parts.length >= 4 && parts[3] && /^[0-9a-f]{32,64}$/i.test(parts[3])) {
        return parts[3].toLowerCase();
      }

      // Si es una credencial enc:v1 de 3 partes (creada antes de Fase B), generamos un salt aleatorio
      // de 16 bytes y lo persistimos adjunto al registro cifrado sin alterar el ciphertext ni el IV.
      const cacheKey = `${usuarioId}:${storedPasswordHash}`;
      const existingFallback = this.fallbackRandomSalts.get(cacheKey);
      if (existingFallback) {
        return existingFallback;
      }

      const newSaltHex = randomBytes(16).toString("hex");
      const updatedHash = `${storedPasswordHash}:${newSaltHex}`;
      try {
        await prisma.usuario.update({
          where: { id: usuarioId },
          data: { passwordHash: updatedHash },
        });
      } catch {
        // Si por concurrencia no se pudo actualizar en DB, conservar en memoria para esta versión
        this.fallbackRandomSalts.set(cacheKey, newSaltHex);
      }
      return newSaltHex;
    }

    const cacheKey = `${usuarioId}:${storedPasswordHash}`;
    let saltHex = this.fallbackRandomSalts.get(cacheKey);
    if (!saltHex) {
      saltHex = randomBytes(16).toString("hex");
      this.fallbackRandomSalts.set(cacheKey, saltHex);
    }
    return saltHex;
  }

  /**
   * Obtiene el catálogo completo de inspectores activos y autorizados para capturar en una terminal física.
   * Cada registro contiene su verificador PBKDF2-HMAC-SHA256, su salt aleatorio único y su offlineToken de 48h.
   */
  async getInspectoresOfflineCatalog(terminal: {
    id: number;
    nombre: string;
    departamentoId: number;
  }): Promise<{
    inspectores: InspectorOfflineItem[];
    terminal: { id: number; nombre: string; departamentoId: number };
    vigenciaSegundos: number;
    servidorTimestamp: string;
  }> {
    const usuariosActivos = await prisma.usuario.findMany({
      where: {
        estado: "ACTIVO",
      },
      include: {
        rol: true,
      },
      orderBy: [{ nombre: "asc" }, { usuario: "asc" }],
    });

    const inspectores: InspectorOfflineItem[] = [];
    const nowSec = Math.floor(Date.now() / 1000);

    for (const u of usuariosActivos) {
      if (!u.rol || u.rol.estado !== "ACTIVO") continue;

      const rolCodigo = u.rol.codigo.toUpperCase();
      // Solo usuarios con rol INSPECTOR y permiso efectivo defectos.capturar pueden realizar capturas de piso
      if (rolCodigo !== "INSPECTOR") continue;

      const efectivos = await permissionsService.getPermisosEfectivos(u.id);
      const permisosEfectivos = efectivos.permisos;
      if (!permisosEfectivos.includes("defectos.capturar")) continue;

      const plainPassword = securityService.decryptPassword(u.passwordHash);
      if (!plainPassword) {
        // Si la cuenta no posee contraseña cifrada compatible, no puede generar verificador PBKDF2 sin login previo
        continue;
      }

      const saltOffline = await this.resolveOrPersistRandomSalt(u.id, u.passwordHash);
      const verifierOffline = this.deriveOfflineVerifier(plainPassword, saltOffline);

      const tokenData = this.generateOfflineToken({
        usuarioId: u.id,
        usuario: u.usuario,
        nombre: u.nombre,
        terminalId: terminal.id,
        terminalNombre: terminal.nombre,
        departamentoId: terminal.departamentoId,
        issuedAtSec: nowSec,
      });

      inspectores.push({
        inspectorId: u.id,
        usuario: u.usuario,
        nombre: u.nombre,
        rolCodigo,
        activo: true,
        permisos: permisosEfectivos,
        saltOffline,
        verifierOffline,
        iteracionesPbkdf2: this.PBKDF2_ITERATIONS,
        offlineToken: tokenData.token,
        emitidoEn: tokenData.emitidoEn,
        expiraEn: tokenData.expiraEn,
        vigenciaSegundos: tokenData.vigenciaSegundos,
      });
    }

    return {
      inspectores,
      terminal: {
        id: terminal.id,
        nombre: terminal.nombre,
        departamentoId: terminal.departamentoId,
      },
      vigenciaSegundos: this.VIGENCIA_SEGUNDOS,
      servidorTimestamp: new Date().toISOString(),
    };
  }
}

export const offlineAuthService = new OfflineAuthService();

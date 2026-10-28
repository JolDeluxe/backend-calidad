import { createHmac, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { env } from "../../../config/env";

export interface TokenPayload {
  usuarioId: number;
  usuario: string;
  nombre: string;
  rolId: number;
  rolCodigo: string;
  sesionId?: number;
}

interface DecodedToken extends TokenPayload {
  iat: number;
  exp: number;
}

const ENC_PREFIX = "enc:v1:";

export class SecurityService {
  /**
   * Obtiene una clave de 32 bytes derivada del JWT_SECRET
   */
  private getEncryptionKey(): Buffer {
    return createHmac("sha256", "cuadra-calidad-password-key").update(env.JWT_SECRET).digest();
  }

  /**
   * Cifra la contraseña con AES-256-GCM para que los administradores autorizados puedan consultarla.
   */
  encryptPassword(password: string): string {
    const key = this.getEncryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    let encrypted = cipher.update(password, "utf8", "hex");
    encrypted += cipher.final("hex");
    const tag = cipher.getAuthTag().toString("hex");
    return `${ENC_PREFIX}${iv.toString("hex")}:${tag}:${encrypted}`;
  }

  /**
   * Desencripta una contraseña cifrada con encryptPassword.
   * Retorna null si no es un formato cifrado reversible o si la integridad falla.
   */
  decryptPassword(storedValue: string): string | null {
    if (!storedValue || !storedValue.startsWith(ENC_PREFIX)) {
      return null;
    }
    try {
      const payload = storedValue.slice(ENC_PREFIX.length);
      const parts = payload.split(":");
      if (parts.length !== 3) return null;
      const [ivHex, tagHex, encryptedHex] = parts;
      if (!ivHex || !tagHex || !encryptedHex) return null;

      const key = this.getEncryptionKey();
      const iv = Buffer.from(ivHex, "hex");
      const tag = Buffer.from(tagHex, "hex");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      let decrypted = decipher.update(encryptedHex, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } catch {
      return null;
    }
  }

  /**
   * Genera el valor para almacenar una contraseña.
   * Por defecto utiliza el cifrado reversible institucional.
   */
  hashPassword(password: string): string {
    return this.encryptPassword(password);
  }

  /**
   * Verifica la contraseña ya sea que esté cifrada con AES-256-GCM o con el hash legado (salt:hash).
   */
  verifyPassword(password: string, storedValue: string): boolean {
    if (storedValue.startsWith(ENC_PREFIX)) {
      const decrypted = this.decryptPassword(storedValue);
      return decrypted === password;
    }

    // Compatibilidad retroactiva con salt:hash legado
    const parts = storedValue.split(":");
    if (parts.length === 2) {
      const [salt, originalHash] = parts;
      if (salt && originalHash) {
        const computedHash = createHmac("sha256", salt).update(password).digest("hex");
        return computedHash === originalHash;
      }
    }

    return false;
  }

  generateRefreshToken(): string {
    return randomBytes(40).toString("hex");
  }

  hashRefreshToken(token: string): string {
    return createHmac("sha256", env.JWT_SECRET).update(token).digest("hex");
  }

  generateAccessToken(payload: TokenPayload): string {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const expInSeconds = nowInSeconds + env.ACCESS_TOKEN_EXPIRES_MINUTES * 60;

    const fullPayload: DecodedToken = {
      ...payload,
      iat: nowInSeconds,
      exp: expInSeconds,
    };

    const payloadEncoded = Buffer.from(JSON.stringify(fullPayload)).toString("base64url");
    const signature = createHmac("sha256", env.JWT_SECRET)
      .update(`${header}.${payloadEncoded}`)
      .digest("base64url");

    return `${header}.${payloadEncoded}.${signature}`;
  }

  verifyAccessToken(token: string): DecodedToken | null {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      const [header, payload, signature] = parts;
      if (!header || !payload || !signature) return null;

      const expectedSignature = createHmac("sha256", env.JWT_SECRET)
        .update(`${header}.${payload}`)
        .digest("base64url");

      if (signature !== expectedSignature) return null;

      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as DecodedToken;
      const nowInSeconds = Math.floor(Date.now() / 1000);

      if (decoded.exp < nowInSeconds) {
        return null;
      }

      return decoded;
    } catch {
      return null;
    }
  }
}

export const securityService = new SecurityService();

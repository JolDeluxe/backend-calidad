import { createHmac, randomBytes } from "node:crypto";
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

export class SecurityService {
  hashPassword(password: string): string {
    const salt = randomBytes(16).toString("hex");
    const hash = createHmac("sha256", salt).update(password).digest("hex");
    return `${salt}:${hash}`;
  }

  verifyPassword(password: string, storedHash: string): boolean {
    const parts = storedHash.split(":");
    if (parts.length !== 2) return false;
    const [salt, originalHash] = parts;
    if (!salt || !originalHash) return false;
    const computedHash = createHmac("sha256", salt).update(password).digest("hex");
    return computedHash === originalHash;
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
import fs from "fs";
import path from "path";

export interface SyncLogEntry {
  proceso: "LOTES_SYNC" | "LEGACY_SYNC";
  nivel: "INFO" | "WARN" | "ERROR";
  timestamp: string; // ISO 8601 UTC
  mensaje: string;
  ejecucionUuid?: string;
  origenDisparador?: string;
  intento?: number;
  proximoReintentoUtc?: string | null;
  archivo?: string;
  ruta?: string;
  hashSha256?: string | null;
  tamanoBytes?: number | string | null;
  fechaModificacionArchivo?: string | null;
  duracionMs?: number;
  estado?: "EN_PROCESO" | "EXITOSO" | "FALLIDO";
  metricas?: {
    leidos?: number;
    insertados?: number;
    actualizados?: number;
    reactivados?: number;
    omitidos?: number;
    rechazados?: number;
    inactivados?: number;
  };
  error?: string | null;
  detalleTecnico?: unknown;
}

export class SyncLogger {
  private primaryLogDir = "C:\\Servidor\\Logs\\Aplicaciones\\Calidad-MBC";
  private fallbackLogDir = path.resolve(process.cwd(), "logs", "sync");
  private activeLogDir: string;
  private maxFileSize = 10 * 1024 * 1024; // 10 MB por archivo antes de rotar
  private retentionDays = 30; // Conservar últimos 30 días

  constructor() {
    this.activeLogDir = this.resolveLogDirectory();
  }

  private resolveLogDirectory(): string {
    try {
      if (fs.existsSync(this.primaryLogDir)) {
        return this.primaryLogDir;
      }
      fs.mkdirSync(this.primaryLogDir, { recursive: true });
      return this.primaryLogDir;
    } catch {
      // Fallback local seguro si la ruta del servidor no es accesible
      try {
        if (!fs.existsSync(this.fallbackLogDir)) {
          fs.mkdirSync(this.fallbackLogDir, { recursive: true });
        }
        return this.fallbackLogDir;
      } catch {
        return process.cwd();
      }
    }
  }

  /**
   * Sanitiza y redacta tokens, contraseñas y credenciales sensibles antes de escribir en disco.
   */
  private redactarSensible(data: unknown): unknown {
    if (typeof data !== "object" || data === null) return data;
    if (Array.isArray(data)) return data.map((item) => this.redactarSensible(item));

    const copia: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      const lower = k.toLowerCase();
      if (
        lower.includes("password") ||
        lower.includes("token") ||
        lower.includes("jwt") ||
        lower.includes("secret") ||
        lower.includes("credential")
      ) {
        copia[k] = "[REDACTED]";
      } else if (typeof v === "object" && v !== null) {
        copia[k] = this.redactarSensible(v);
      } else {
        copia[k] = v;
      }
    }
    return copia;
  }

  /**
   * Rota el archivo si excede 10 MB y purga logs antiguos (> 30 días).
   */
  private rotarSiEsNecesario(filePath: string) {
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size >= this.maxFileSize) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const rotatedPath = filePath.replace(/\.log$/, `-${timestamp}.log`);
          fs.renameSync(filePath, rotatedPath);
        }
      }

      // Purga de archivos antiguos
      const dir = path.dirname(filePath);
      const files = fs.readdirSync(dir);
      const now = Date.now();
      const maxAgeMs = this.retentionDays * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (file.endsWith(".log") && file.includes("-202")) {
          const fullPath = path.join(dir, file);
          const fStat = fs.statSync(fullPath);
          if (now - fStat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(fullPath);
          }
        }
      }
    } catch {
      // No detener el proceso si falla la rotación de archivo secundario
    }
  }

  /**
   * Escribe una entrada estructurada en el archivo correspondiente (lotes o legacy).
   */
  log(entry: SyncLogEntry) {
    const fileName = entry.proceso === "LOTES_SYNC" ? "lotes-sync.log" : "legacy-sync.log";
    const filePath = path.join(this.activeLogDir, fileName);

    this.rotarSiEsNecesario(filePath);

    const sanitizedEntry = this.redactarSensible(entry) as SyncLogEntry;
    const line = JSON.stringify(sanitizedEntry) + "\n";

    try {
      fs.appendFileSync(filePath, line, "utf8");
    } catch {
      // Fallback de emergencia a stderr para no perder trazabilidad
      console.error("[SYNC_LOGGER_FALLBACK]", line);
    }
  }

  getActiveLogDir(): string {
    return this.activeLogDir;
  }
}

export const syncLogger = new SyncLogger();

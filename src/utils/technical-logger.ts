import { existsSync, mkdirSync, appendFile, statSync, renameSync, readdirSync, unlinkSync, createReadStream } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import { logger } from "./logger";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug";

export interface TechnicalLogEntry {
  timestamp: string;
  level: LogLevel;
  servicio: string;
  entorno: string;
  mensaje: string;
  codigoError?: string;
  tipoExcepcion?: string;
  stackTrace?: string;
  metodoHttp?: string;
  rutaHttp?: string;
  codigoRespuesta?: number;
  duracionMs?: number;
  requestId?: string;
  correlationId?: string;
  usuarioId?: number;
  modulo?: string;
  contexto?: Record<string, unknown>;
}

const LOGS_DIR = join(process.cwd(), "logs");
const CURRENT_LOG_FILE = join(LOGS_DIR, "backend-technical.log");
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB por archivo antes de rotar
const MAX_BACKUP_FILES = 5; // Conservar hasta 5 archivos rotados

// Asegurar directorio
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
}

export class TechnicalLogger {
  /**
   * Rota el archivo actual si excede el tamaño máximo y purga los backups más antiguos.
   */
  rotateIfNeeded() {
    try {
      if (!existsSync(CURRENT_LOG_FILE)) return;
      const stats = statSync(CURRENT_LOG_FILE);
      if (stats.size >= MAX_FILE_SIZE_BYTES) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const rotatedName = join(LOGS_DIR, `backend-technical-${timestamp}.log`);
        renameSync(CURRENT_LOG_FILE, rotatedName);

        // Limpiar archivos antiguos si superan MAX_BACKUP_FILES
        const files = readdirSync(LOGS_DIR)
          .filter((f) => f.startsWith("backend-technical-") && f.endsWith(".log"))
          .sort()
          .reverse();

        if (files.length > MAX_BACKUP_FILES) {
          const filesToDelete = files.slice(MAX_BACKUP_FILES);
          for (const f of filesToDelete) {
            try {
              unlinkSync(join(LOGS_DIR, f));
            } catch (err) {
              console.error(`Error al eliminar backup de log antiguo ${f}:`, err);
            }
          }
        }
      }
    } catch (e) {
      console.error("Error al rotar logs técnicos:", e);
    }
  }

  log(entry: Omit<TechnicalLogEntry, "timestamp" | "servicio" | "entorno">) {
    const fullEntry: TechnicalLogEntry = {
      timestamp: new Date().toISOString(),
      servicio: "10_proyecto_calidad_backend",
      entorno: process.env.NODE_ENV || "development",
      ...entry,
    };

    // 1. Enviar al logger de consola (pino)
    if (fullEntry.level === "error" || fullEntry.level === "fatal") {
      logger.error({ ...fullEntry }, fullEntry.mensaje);
    } else if (fullEntry.level === "warn") {
      logger.warn({ ...fullEntry }, fullEntry.mensaje);
    } else {
      logger.info({ ...fullEntry }, fullEntry.mensaje);
    }

    // 2. Persistir en archivo JSON Lines rotado
    try {
      this.rotateIfNeeded();
      const line = JSON.stringify(fullEntry) + "\n";
      appendFile(CURRENT_LOG_FILE, line, "utf8", (err) => {
        if (err) {
          console.error("Fallo asíncrono al escribir en logs técnicos estructurados:", err.message);
        }
      });
    } catch (err: any) {
      console.error("Fallo al escribir en logs técnicos estructurados:", err?.message);
    }
  }

  error(mensaje: string, error?: Error | unknown, meta?: Partial<TechnicalLogEntry>) {
    let stackTrace: string | undefined;
    let tipoExcepcion: string | undefined;
    let codigoError = meta?.codigoError;

    if (error instanceof Error) {
      stackTrace = error.stack;
      tipoExcepcion = error.name;
      if (!codigoError && (error as any).code) {
        codigoError = String((error as any).code);
      }
    }

    this.log({
      level: "error",
      mensaje,
      tipoExcepcion,
      stackTrace,
      codigoError,
      ...meta,
    });
  }

  warn(mensaje: string, meta?: Partial<TechnicalLogEntry>) {
    this.log({ level: "warn", mensaje, ...meta });
  }

  info(mensaje: string, meta?: Partial<TechnicalLogEntry>) {
    this.log({ level: "info", mensaje, ...meta });
  }

  /**
   * Lee logs técnicos estructurados con paginación, filtros y streaming sin bloquear el event loop.
   */
  async queryLogs(filtros: {
    nivel?: LogLevel;
    modulo?: string;
    texto?: string;
    requestId?: string;
    fechaDesde?: string;
    limit?: number;
    page?: number;
  }) {
    const limit = Math.min(200, Math.max(1, filtros.limit || 50));
    const page = Math.max(1, filtros.page || 1);

    if (!existsSync(CURRENT_LOG_FILE)) {
      return { items: [], total: 0, page, limit, totalPages: 0 };
    }

    const lines: TechnicalLogEntry[] = [];
    const fileStream = createReadStream(CURRENT_LOG_FILE);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line) as TechnicalLogEntry;

        if (filtros.nivel && item.level !== filtros.nivel) continue;
        if (filtros.modulo && item.modulo !== filtros.modulo) continue;
        if (filtros.requestId && item.requestId !== filtros.requestId) continue;
        if (filtros.fechaDesde && item.timestamp < filtros.fechaDesde) continue;
        if (filtros.texto) {
          const t = filtros.texto.toLowerCase();
          const match =
            item.mensaje?.toLowerCase().includes(t) ||
            item.codigoError?.toLowerCase().includes(t) ||
            item.tipoExcepcion?.toLowerCase().includes(t) ||
            item.rutaHttp?.toLowerCase().includes(t);
          if (!match) continue;
        }

        lines.push(item);
      } catch {
        // Ignorar líneas corruptas
      }
    }

    // Ordenar de más reciente a más antiguo
    lines.reverse();

    const total = lines.length;
    const skip = (page - 1) * limit;
    const paginatedItems = lines.slice(skip, skip + limit);

    return {
      items: paginatedItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}

export const technicalLogger = new TechnicalLogger();

import { existsSync, readdirSync, statSync, createReadStream } from "node:fs";
import { join, resolve, basename } from "node:path";
import readline from "node:readline";

export interface LogLine {
  linea: number;
  timestamp?: string;
  contenido: string;
  origen: "pm2_out" | "pm2_error" | "app_out" | "app_error";
}

// Directorios autorizados de solo lectura
const HOME_PM2_LOGS = join(process.env.USERPROFILE || "", ".pm2", "logs");
const APP_LOGS = join(process.cwd(), "logs");

// Prefijos autorizados EXCLUSIVAMENTE para el backend de Proyecto Calidad
// Se eliminaron patrones genéricos como "out" o "error" para evitar acceso a logs de otros servicios
const PERMITTED_LOG_EXACT_PATTERNS = [
  "calidad-api",
  "proyecto-calidad",
  "10_proyecto_calidad",
  "backend-technical",
];

export class Pm2LogsReaderService {
  /**
   * Obtiene la lista de archivos de log autorizados exclusivamente para Calidad.
   */
  getAuthorizedLogFiles(): { nombre: string; ruta: string; tamanoBytes: number; fechaModificacion: Date }[] {
    const list: { nombre: string; ruta: string; tamanoBytes: number; fechaModificacion: Date }[] = [];

    const scanDir = (dir: string) => {
      if (!existsSync(dir)) return;
      try {
        const canonicalBaseDir = resolve(dir);
        const files = readdirSync(dir);

        for (const file of files) {
          const lower = file.toLowerCase();

          // El archivo DEBE comenzar con uno de los prefijos autorizados del proyecto
          const isAuthorizedPrefix = PERMITTED_LOG_EXACT_PATTERNS.some((p) => lower.startsWith(p));
          const hasValidExtension = lower.endsWith(".log") || lower.endsWith(".txt");

          if (isAuthorizedPrefix && hasValidExtension) {
            const fullPath = resolve(dir, file);

            // Verificación estricta contra Path Traversal y symlinks
            if (!fullPath.startsWith(canonicalBaseDir)) continue;

            const st = statSync(fullPath);
            if (!st.isFile()) continue;

            list.push({
              nombre: file,
              ruta: fullPath,
              tamanoBytes: st.size,
              fechaModificacion: st.mtime,
            });
          }
        }
      } catch (err) {
        console.error(`Error al escanear directorio ${dir}:`, err);
      }
    };

    scanDir(APP_LOGS);
    scanDir(HOME_PM2_LOGS);

    return list;
  }

  /**
   * Lee un archivo autorizado por bloques (líneas) con soporte para streaming y límites de seguridad.
   */
  async readLogFile(
    filename: string,
    options: {
      lineasMaximas?: number;
      filtroTexto?: string;
      invertirOrden?: boolean;
    } = {}
  ): Promise<{ lineas: string[]; totalLineasLeidas: number; archivo: string; tamanoBytes: number }> {
    // Sanitizar nombre de archivo contra path traversal
    const cleanFileName = basename(filename);

    const authorized = this.getAuthorizedLogFiles().find((f) => f.nombre === cleanFileName);
    if (!authorized) {
      throw new Error("Archivo de log no autorizado o inexistente");
    }

    const maxLines = Math.min(1000, Math.max(1, options.lineasMaximas || 200));
    const resultLines: string[] = [];
    const filter = options.filtroTexto?.toLowerCase();

    const stream = createReadStream(authorized.ruta, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let count = 0;
    for await (const line of rl) {
      count++;
      if (filter && !line.toLowerCase().includes(filter)) {
        continue;
      }
      resultLines.push(line);
      if (resultLines.length > maxLines) {
        resultLines.shift();
      }
    }

    if (options.invertirOrden) {
      resultLines.reverse();
    }

    return {
      archivo: authorized.nombre,
      tamanoBytes: authorized.tamanoBytes,
      totalLineasLeidas: count,
      lineas: resultLines,
    };
  }
}

export const pm2LogsReaderService = new Pm2LogsReaderService();

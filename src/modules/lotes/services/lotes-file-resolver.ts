import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface FileMetadataResult {
  filePath: string;
  sizeBytes: number;
  mtime: Date;
  sha256: string;
}

export interface ResolverOptions {
  customPath?: string;
  strictProduction?: boolean;
}

/**
 * Rutas candidatas oficiales para el maestro de lotes en Producción (MBC)
 */
export const CANDIDATE_LOTES_PATHS_PRODUCTION = [
  process.env.LOTES_CSV_PATH,
  "H:\\CALIDAD\\App\\Quality System\\DataBase\\Calidad Datos Base.csv",
  "\\\\200.1.1.58\\usuariosmbc\\CALIDAD\\App\\Quality System\\DataBase\\Calidad Datos Base.csv",
  "\\\\GC-SRV-ARCHI-01.gc.com\\USUARIOSMBC\\CALIDAD\\App\\Quality System\\DataBase\\Calidad Datos Base.csv",
].filter((p): p is string => Boolean(p));

export const CANDIDATE_LOTES_PATHS_DEV = [
  ...CANDIDATE_LOTES_PATHS_PRODUCTION,
  "C:\\Servidor\\Aplicaciones\\Calidad-MBC\\Documentacion\\DtaosBse\\Calidad Datos Base.csv",
  "C:\\Users\\MBCPROEW10028\\Downloads\\DtaosBse\\Calidad Datos Base.csv",
  path.resolve(process.cwd(), "test", "fixtures", "Calidad Datos Base.csv"),
].filter((p): p is string => Boolean(p));

/**
 * Resuelve la ruta oficial del archivo CSV maestro con protección contra fallback silencioso a copias obsoletas.
 */
export async function resolverRutaLotesCSV(options: ResolverOptions = {}): Promise<string> {
  const isProduction = process.env.NODE_ENV === "production";
  const strict = options.strictProduction !== undefined ? options.strictProduction : isProduction;

  // 1. Si se provee una ruta explícita válida
  if (options.customPath) {
    if (fs.existsSync(options.customPath)) {
      const stat = fs.statSync(options.customPath);
      if (stat.size > 0) return options.customPath;
    }
    throw new Error(`La ruta personalizada de lotes no existe o está vacía: ${options.customPath}`);
  }

  // 2. Lista de rutas candidatas según entorno
  const candidates = strict ? CANDIDATE_LOTES_PATHS_PRODUCTION : CANDIDATE_LOTES_PATHS_DEV;

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.size > 0) {
          return p;
        }
      }
    } catch {
      // Continuar con siguiente candidato
    }
  }

  const modoTexto = strict ? "PRODUCCIÓN ESTRICTO (sin fallback obsoleto)" : "DESARROLLO / PRUEBAS";
  throw new Error(
    `[ERROR CRÍTICO]: No se encontró el archivo maestro 'Calidad Datos Base.csv' en ninguna de las rutas evaluadas [Modo: ${modoTexto}]:\n` +
      candidates.map((c) => `  - ${c}`).join("\n") +
      `\nAcción requerida: Verifique que la unidad H: esté montada o que la variable LOTES_CSV_PATH apunte a una ruta accesible.`
  );
}

/**
 * Verifica que el archivo no esté siendo escrito actualmente por otro proceso (Anti-Torn-Write).
 * Comprueba que el tamaño en bytes sea idéntico tras una ventana de estabilización.
 */
export async function verificarEstabilidadYAccesoArchivo(
  filePath: string,
  debounceMs = 300
): Promise<FileMetadataResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`El archivo no existe en la ruta especificada: ${filePath}`);
  }

  const stat1 = fs.statSync(filePath);
  if (stat1.size === 0) {
    throw new Error(`El archivo existe pero tiene 0 bytes (vacío): ${filePath}`);
  }

  if (debounceMs > 0) {
    await new Promise((r) => setTimeout(r, debounceMs));
    const stat2 = fs.statSync(filePath);
    if (stat1.size !== stat2.size || stat1.mtimeMs !== stat2.mtimeMs) {
      throw new Error(
        `El archivo '${filePath}' está cambiando de tamaño o modificación (${stat1.size}B -> ${stat2.size}B). Podría estar en proceso de escritura por el ERP.`
      );
    }
  }

  // Calcular SHA-256 e inspeccionar integridad
  const content = fs.readFileSync(filePath);
  const hash = crypto.createHash("sha256").update(content).digest("hex");

  return {
    filePath,
    sizeBytes: stat1.size,
    mtime: stat1.mtime,
    sha256: hash,
  };
}

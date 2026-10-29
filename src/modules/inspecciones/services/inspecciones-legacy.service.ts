import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logger } from "../../../utils/logger";

export interface LegacyInspeccionData {
  id: number;
  folio: string;
  claveIdempotencia?: string | null;
  fechaInspeccion: Date | string;
  horma?: string | null;
  lineaTexto?: string | null;
  inspector: {
    id: number;
    nombre: string;
    usuario: string;
  };
  departamentoAuditoria: {
    id: number;
    codigo: string;
    nombre: string;
  };
  lote: {
    id: number;
    lote: string;
    lista: string;
    modelo: string;
    descripcion?: string | null;
  };
  linea?: {
    id: number;
    codigo: string;
    nombre: string;
  } | null;
  detalles: Array<{
    id?: number;
    paresDefectuosos: number;
    defecto: {
      id: number;
      clave: number;
      defecto: string;
    };
    departamentoOrigen?: {
      id: number;
      codigo: string;
      nombre: string;
    } | null;
  }>;
}

export interface LegacyWriteResult {
  sincronizado: boolean;
  yaEstabaSincronizado: boolean;
  deshabilitadoPorDefecto?: boolean;
  archivoDestino: string;
  lineasEscritas: number;
  esAviosSinLinea: boolean;
  esAdornoIndividual: boolean;
  error?: string;
}

const HEADER_14_COLS =
  "No\tDepartamento\tFecha\tLista\tLote\tLinea\tModelo\tDescripcion\tDefDepto\tId\tDefecto\tPrs\tHorma\tUsuario";

const DEPT_FILE_MAP: Record<string, { fileName: string; displayDepto: string }> = {
  CORTE: { fileName: "Defectos_corte.txt", displayDepto: "CORTE" },
  PRELIMINARES: { fileName: "Defectos_Preliminares.txt", displayDepto: "PRELIMINARES" },
  BORDADO_LASER: { fileName: "Defectos_Bordado.txt", displayDepto: "BORDADO" },
  BORDADO: { fileName: "Defectos_Bordado.txt", displayDepto: "BORDADO" },
  PESPUNTE: { fileName: "Defectos_Pespunte.txt", displayDepto: "PESPUNTE" },
  MONTADO: { fileName: "Defectos_Montado.txt", displayDepto: "MONTADO" },
  AVIOS: { fileName: "Defectos_Avios.txt", displayDepto: "AVIOS" },
  ACABADO: { fileName: "Defectos_Acabado.txt", displayDepto: "ACABADO" },
  ADORNO: { fileName: "Defectos_Adorno.txt", displayDepto: "ADORNO" },
};

/**
 * Servicio opcional de exportación idempotente hacia archivos TXT/CSV legacy.
 *
 * ARQUITECTURA OFFLINE-FIRST MBC:
 * - MySQL (`inspecciones_cabecera` + `inspecciones_detalle`) es la fuente principal y definitiva
 *   de todas las nuevas capturas operativas.
 * - Los archivos TXT/CSV legacy (`Defectos_*.txt`, `Df_Ado.txt`, `Lotes_*.txt`) se conservan
 *   como fuentes históricas de importación y consulta (`seed-defectos-txt.ts`, `lotes-import.service.ts`),
 *   por lo que la escritura hacia TXT está DESHABILITADA POR DEFECTO (`LEGACY_TXT_EXPORT_ENABLED !== "true"`).
 * - Si se habilita explícitamente por configuración (`LEGACY_TXT_EXPORT_ENABLED=true` o `setEnabled(true)`),
 *   opera como efecto secundario best-effort e idempotente que NUNCA invalida ni bloquea una captura
 *   ya confirmada en MySQL:
 *   1. Respeta la estructura real de 14 columnas tabuladas en codificación Latin-1 (ISO-8859-1).
 *   2. Respeta el desplazamiento histórico de AVÍOS (`Defectos_Avios.txt`), donde las filas de datos
 *      omiten el valor de la columna `Linea` (13 columnas de datos + tabulador final).
 *   3. Preserva la distinción en ADORNO entre capturas individuales por lote (`Defectos_Adorno.txt`)
 *      y el acumulado semanal legacy (`Df_Ado.txt` con modelo fijo `4Q18RS`), evitando duplicar pares.
 */
export class InspeccionesLegacyService {
  private customBaseDir: string | null = null;
  private enabled: boolean = process.env.LEGACY_TXT_EXPORT_ENABLED === "true";
  private simulateFailureCount = 0;
  private writeChain: Promise<unknown> = Promise.resolve();
  private exportedKeysInMemory = new Set<string>();

  /**
   * Indica si la exportación opcional a archivos TXT legacy está habilitada.
   * Por defecto es `false` (MySQL es el destino principal y definitivo).
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Permite habilitar o deshabilitar explícitamente la exportación a archivos TXT legacy.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Permite configurar un directorio base específico (útil para pruebas o configuración explícita).
   */
  setBaseDir(dir: string | null): void {
    this.customBaseDir = dir;
    this.exportedKeysInMemory.clear();
  }

  /**
   * Permite inyectar N fallos simulados de escritura en disco para verificar que un error
   * de archivo legacy jamás invalida una inspección ya confirmada en MySQL.
   */
  setSimulateFailureCount(count: number): void {
    this.simulateFailureCount = Math.max(0, count);
  }

  getBaseDir(): string {
    if (this.customBaseDir) {
      return this.customBaseDir;
    }
    if (process.env.LEGACY_DATA_DIR) {
      return process.env.LEGACY_DATA_DIR;
    }
    return join(tmpdir(), "mbc_calidad_legacy_txt");
  }

  /**
   * Formatea una fecha a ` DD / MM / YYYY ` tal como lo genera la macro de Excel legacy.
   */
  formatLegacyDate(dateInput: Date | string): string {
    const d = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
    const validDate = Number.isNaN(d.getTime()) ? new Date() : d;
    const dd = String(validDate.getUTCDate()).padStart(2, "0");
    const mm = String(validDate.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = validDate.getUTCFullYear();
    return ` ${dd} / ${mm} / ${yyyy} `;
  }

  /**
   * Calcula el siguiente número consecutivo `No` leyendo la última línea con número válido del archivo.
   */
  private getNextConsecutiveNo(filePath: string): number {
    if (!existsSync(filePath)) {
      return 1;
    }
    try {
      const content = readFileSync(filePath, "latin1");
      const lines = content.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 1; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        const firstCol = line.split("\t")[0]?.trim();
        const parsed = Number.parseInt(firstCol || "", 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
          return parsed + 1;
        }
      }
      return 1;
    } catch {
      return 1;
    }
  }

  /**
   * Construye las líneas tabuladas para una inspección según las reglas del departamento.
   */
  buildLegacyLines(
    inspeccion: LegacyInspeccionData,
    startingNo: number,
  ): { lines: string[]; fileName: string; esAviosSinLinea: boolean; esAdornoIndividual: boolean } {
    const deptoCode = (inspeccion.departamentoAuditoria?.codigo || "MONTADO").toUpperCase();
    const mapping = DEPT_FILE_MAP[deptoCode] ?? {
      fileName: `Defectos_${deptoCode}.txt`,
      displayDepto: deptoCode,
    };

    const esAviosSinLinea = deptoCode === "AVIOS";
    const esAdornoIndividual = deptoCode === "ADORNO";

    const fechaStr = this.formatLegacyDate(inspeccion.fechaInspeccion);
    const lista = (inspeccion.lote?.lista || "").replace(/\t/g, " ").trim();
    const loteCod = (inspeccion.lote?.lote || "").replace(/\t/g, " ").trim();
    const lineaStr = (inspeccion.linea?.codigo || inspeccion.lineaTexto || "NA").replace(/\t/g, " ").trim();
    const modelo = (inspeccion.lote?.modelo || "").replace(/\t/g, " ").trim();
    const descripcion = (inspeccion.lote?.descripcion || "NA").replace(/\t/g, " ").trim() || "NA";
    const horma = (inspeccion.horma || "").replace(/\t/g, " ").trim();
    const usuario = (inspeccion.inspector?.nombre || inspeccion.inspector?.usuario || "INSPECTOR")
      .replace(/\t/g, " ")
      .trim();

    // En ADORNO individual nunca se debe usar el modelo dummy semanal 4Q18RS si el lote tiene su modelo real
    const detalles = Array.isArray(inspeccion.detalles) ? inspeccion.detalles : [];
    const lines: string[] = [];

    detalles.forEach((det, idx) => {
      const no = startingNo + idx;
      const defDepto = (det.departamentoOrigen?.codigo || mapping.displayDepto)
        .replace(/_LASER$/i, "")
        .replace(/\t/g, " ")
        .trim();
      const claveDefecto = String(det.defecto?.clave ?? "");
      const nombreDefecto = (det.defecto?.defecto || "").replace(/\t/g, " ").trim();
      const prs = String(det.paresDefectuosos ?? 1);

      if (esAviosSinLinea) {
        // AVÍOS: El encabezado tiene 14 nombres de columna, pero las filas de datos omiten `Linea`
        // (13 valores de datos seguidos de un tabulador final, tal como lo genera la macro histórica).
        const row = [
          String(no),
          mapping.displayDepto,
          fechaStr,
          lista,
          loteCod,
          modelo,
          descripcion,
          defDepto,
          claveDefecto,
          nombreDefecto,
          prs,
          horma || " ",
          usuario,
          "",
        ].join("\t");
        lines.push(row);
      } else {
        // Formato estándar de 14 columnas tabuladas
        const row = [
          String(no),
          mapping.displayDepto,
          fechaStr,
          lista,
          loteCod,
          lineaStr,
          modelo,
          descripcion,
          defDepto,
          claveDefecto,
          nombreDefecto,
          prs,
          horma,
          usuario,
        ].join("\t");
        lines.push(row);
      }
    });

    return {
      lines,
      fileName: mapping.fileName,
      esAviosSinLinea,
      esAdornoIndividual,
    };
  }

  /**
   * Verifica si una inspección ya fue exportada en memoria durante el proceso actual.
   */
  isSynced(inspeccionId: number, claveIdempotencia?: string | null): boolean {
    if (!this.enabled) return false;
    const keyById = `id:${inspeccionId}`;
    if (this.exportedKeysInMemory.has(keyById)) return true;
    if (claveIdempotencia && this.exportedKeysInMemory.has(`idem:${claveIdempotencia}`)) return true;
    return false;
  }

  /**
   * Exporta de forma opcional, best-effort e idempotente una inspección ya confirmada en MySQL
   * hacia su archivo TXT legacy correspondiente.
   *
   * - Si `this.enabled === false` (valor por defecto), retorna inmediatamente sin tocar el disco.
   * - Si `this.enabled === true` y ocurre un error de disco, lo registra en el log como advertencia
   *   pero NUNCA lanza excepción ni invalida la persistencia central en MySQL.
   */
  async ensureLegacySynced(inspeccion: LegacyInspeccionData): Promise<LegacyWriteResult> {
    if (!this.enabled) {
      const deptoCode = (inspeccion.departamentoAuditoria?.codigo || "MONTADO").toUpperCase();
      return {
        sincronizado: true,
        yaEstabaSincronizado: false,
        deshabilitadoPorDefecto: true,
        archivoDestino: "",
        lineasEscritas: 0,
        esAviosSinLinea: deptoCode === "AVIOS",
        esAdornoIndividual: deptoCode === "ADORNO",
      };
    }

    const run = async (): Promise<LegacyWriteResult> => {
      const baseDir = this.getBaseDir();
      if (!existsSync(baseDir)) {
        mkdirSync(baseDir, { recursive: true });
      }

      const keyById = `id:${inspeccion.id}`;
      const keyByIdem = inspeccion.claveIdempotencia ? `idem:${inspeccion.claveIdempotencia}` : null;
      const deptoCode = (inspeccion.departamentoAuditoria?.codigo || "MONTADO").toUpperCase();
      const mapping = DEPT_FILE_MAP[deptoCode] ?? {
        fileName: `Defectos_${deptoCode}.txt`,
        displayDepto: deptoCode,
      };
      const filePath = join(baseDir, mapping.fileName);

      if (
        this.exportedKeysInMemory.has(keyById) ||
        (keyByIdem && this.exportedKeysInMemory.has(keyByIdem))
      ) {
        return {
          sincronizado: true,
          yaEstabaSincronizado: true,
          archivoDestino: filePath,
          lineasEscritas: Array.isArray(inspeccion.detalles) ? inspeccion.detalles.length : 0,
          esAviosSinLinea: deptoCode === "AVIOS",
          esAdornoIndividual: deptoCode === "ADORNO",
        };
      }

      if (this.simulateFailureCount > 0) {
        this.simulateFailureCount -= 1;
        throw new Error("Fallo simulado de escritura en sistema de archivos legacy (disco/permisos)");
      }

      if (!existsSync(filePath)) {
        writeFileSync(filePath, `${HEADER_14_COLS}\r\n`, { encoding: "latin1" });
      }

      const nextNo = this.getNextConsecutiveNo(filePath);
      const built = this.buildLegacyLines(inspeccion, nextNo);

      if (built.lines.length > 0) {
        const payloadToAppend = built.lines.map((l) => `${l}\r\n`).join("");
        appendFileSync(filePath, payloadToAppend, { encoding: "latin1" });
      }

      this.exportedKeysInMemory.add(keyById);
      if (keyByIdem) {
        this.exportedKeysInMemory.add(keyByIdem);
      }

      return {
        sincronizado: true,
        yaEstabaSincronizado: false,
        archivoDestino: filePath,
        lineasEscritas: built.lines.length,
        esAviosSinLinea: built.esAviosSinLinea,
        esAdornoIndividual: built.esAdornoIndividual,
      };
    };

    const resultPromise = this.writeChain.then(run, run);
    this.writeChain = resultPromise.catch(() => undefined);

    try {
      return await resultPromise;
    } catch (err: any) {
      logger.warn(
        { err, inspeccionId: inspeccion.id, folio: inspeccion.folio },
        "Advertencia: fallo en exportación opcional a archivo TXT legacy; la inspección permanece confirmada en MySQL",
      );
      return {
        sincronizado: false,
        yaEstabaSincronizado: false,
        archivoDestino: "",
        lineasEscritas: 0,
        esAviosSinLinea: false,
        esAdornoIndividual: false,
        error: err?.message || "Error de escritura legacy",
      };
    }
  }
}

export const inspeccionesLegacyService = new InspeccionesLegacyService();

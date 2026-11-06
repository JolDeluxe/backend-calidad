import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { prisma } from '../../../config/database';
import { parseCSVLine, extraerModelo } from '../../lotes/services/lotes-import.service';
import { legacySyncLockService } from './legacy-sync-lock.service';

export type ModoDepartamento = 'WEB' | 'LEGACY';

export interface ArchivoDepartamentoConfig {
  archivo: string;
  departamentoCodigo: string;
  esAviosSinLinea: boolean;
}

export const ARCHIVOS_PRODUCCION_LEGACY: ArchivoDepartamentoConfig[] = [
  { archivo: 'Defectos_Preliminares.txt', departamentoCodigo: 'PRELIMINARES', esAviosSinLinea: false },
  { archivo: 'Defectos_Avios.txt', departamentoCodigo: 'AVIOS', esAviosSinLinea: true },
  { archivo: 'Defectos_Bordado.txt', departamentoCodigo: 'BORDADO_Y_LASER', esAviosSinLinea: false },
  { archivo: 'Defectos_corte.txt', departamentoCodigo: 'CORTE', esAviosSinLinea: false },
  { archivo: 'Defectos_Montado.txt', departamentoCodigo: 'MONTADO', esAviosSinLinea: false },
  { archivo: 'Defectos_Pespunte.txt', departamentoCodigo: 'PESPUNTE', esAviosSinLinea: false },
  { archivo: 'Defectos_Acabado.txt', departamentoCodigo: 'ACABADO', esAviosSinLinea: false },
];

export interface ParsedLegacyRow {
  lineNumber: number;
  archivoOrigen: string;
  anioOrigen: number;
  noOriginal: string;
  deptoAuditoriaTexto: string;
  fechaTexto: string;
  fechaParseada: Date;
  fechaIso: string;
  lista: string;
  lote: string;
  lineaTexto: string;
  modelo: string;
  descripcion: string;
  defDeptoTexto: string;
  defectoClave: number;
  defectoNombre: string;
  pares: number;
  horma: string;
  usuarioTexto: string;
  hashFila: string;
}

export interface RejectedRowInfo {
  lineNumber: number;
  noOriginal: string;
  motivo: string;
  rawPreview: string;
}

export interface FileSyncResult {
  archivo: string;
  departamento: string;
  modo: ModoDepartamento;
  omitidoPorModoWeb: boolean;
  sincronizacionId?: number;
  ejecucionUuid?: string;
  estado: 'OMITIDO_WEB' | 'BLOQUEADO' | 'EXITOSO' | 'FALLIDO';
  registrosDetectados: number;
  registrosInsertados: number;
  registrosActualizados: number;
  registrosOmitidos: number;
  registrosRechazados: number;
  erroresCount: number;
  rechazos: RejectedRowInfo[];
  mensajeError?: string;
}

export interface SyncOptions {
  baseDir?: string;
  lotesCsvPath?: string;
  departamentosWeb?: string[];
  archivosFiltro?: string[];
  stabilityDelayMs?: number;
  lockTtlMs?: number;
  simulateInstabilityOnFile?: string;
  simulateInterruptionOnFile?: string;
  shouldAbort?: () => Promise<string | null> | string | null;
}

export function normalizarTextoCanonico(str: string): string {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizarUsuarioCanonico(str: string): string {
  const n = normalizarTextoCanonico(str);
  if (n.startsWith('ALBA MARISOL MU')) return 'ALBA MARISOL MUNOZ';
  if (n.startsWith('VANESSA JACQUELIN VALLECIL')) return 'VANESSA JACQUELIN VALLECILLO';
  if (n.startsWith('YOLANDA FLOR')) return 'YOLANDA FLORES';
  if (n.startsWith('ULISES MORENO') || n.startsWith('ULISES ISRAEL MORENO')) {
    return 'ULISES ISRAEL MORENO GALLEGOS';
  }
  return n;
}

export function normalizarLineaCanonico(val: string, esAviosSinLinea = false): string {
  if (esAviosSinLinea) return 'L1';
  if (!val) return 'L1';
  const v = val.trim().toUpperCase();
  if (v === 'L1') return 'L1';
  if (v === 'L2') return 'L2';
  if (v === 'ACCESORIO' || v === 'ACCESORIOS') return 'L1';
  if (v === 'NA' || v === 'N/A' || v === '' || v === 'LINEA') return 'L1';
  if (/L1/i.test(v) && !/L2/i.test(v)) return 'L1';
  if (/L2/i.test(v) || /LK2/i.test(v) || /LO2/i.test(v) || /LÑ2/i.test(v)) return 'L2';
  if (v === '1' || v === '1L' || v === 'LI') return 'L1';
  if (v === '2' || v === '2L') return 'L2';
  if (/^\d+$/.test(v)) {
    if (v.endsWith('1')) return 'L1';
    if (v.endsWith('2')) return 'L2';
  }
  return 'L1';
}

export function parseFechaLegacy(fechaRaw: string): Date | null {
  const m = (fechaRaw || '').match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const y = parseInt(m[3], 10);
  if (y < 2000 || y > 2100 || mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, mo, d, 12, 0, 0));
}

export function calcularHashFilaCanonico(params: {
  archivoOrigen: string;
  anioOrigen: number;
  noOriginal: string;
  fechaIso: string;
  lista: string;
  lote: string;
  lineaTexto: string;
  modelo: string;
  defDeptoTexto: string;
  defectoClave: number;
  pares: number;
  horma: string;
  usuarioTexto: string;
}): string {
  const esAvios = params.archivoOrigen === 'Defectos_Avios.txt';
  const payload = [
    params.archivoOrigen.trim(),
    String(params.anioOrigen),
    params.noOriginal.trim(),
    params.fechaIso.trim(),
    normalizarTextoCanonico(params.lista),
    normalizarTextoCanonico(params.lote),
    normalizarLineaCanonico(params.lineaTexto, esAvios),
    normalizarTextoCanonico(params.modelo),
    normalizarTextoCanonico(params.defDeptoTexto),
    String(params.defectoClave || 0),
    String(params.pares || 1),
    normalizarTextoCanonico(params.horma),
    normalizarUsuarioCanonico(params.usuarioTexto),
  ].join('|');

  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Servicio de Sincronización Incremental No Destructiva Legacy -> Sistema Web MBC (FASE 3.4).
 */
export class LegacyIncrementalSyncService {
  /**
   * Determina qué departamentos operan en modo WEB (por defecto PRELIMINARES).
   */
  getDepartamentosEnModoWeb(overrideList?: string[]): Set<string> {
    const rawList =
      overrideList ??
      (process.env.DEPARTAMENTOS_EN_LINEA
        ? process.env.DEPARTAMENTOS_EN_LINEA.split(',')
        : ['PRELIMINARES']);

    const result = new Set<string>();
    for (const item of rawList) {
      const clean = normalizarTextoCanonico(item).replace(/\s+/g, '_');
      if (!clean) continue;
      if (clean === 'BORDADO' || clean === 'BORDADO_Y_LASER') {
        result.add('BORDADO_Y_LASER');
      } else {
        result.add(clean);
      }
    }
    return result;
  }

  /**
   * Resuelve el directorio de lectura de los TXT verificando accesibilidad real.
   */
  resolveBaseDir(customDir?: string): string {
    const candidates = [
      customDir,
      process.env.HISTORICO_DEFECTOS_DIR,
      'H:\\CALIDAD\\App\\Quality System\\DataBase',
      '\\\\200.1.1.58\\usuariosmbc\\CALIDAD\\App\\Quality System\\DataBase',
      '\\\\GC-SRV-ARCHI-01.gc.com\\USUARIOSMBC\\CALIDAD\\App\\Quality System\\DataBase',
      'C:\\Servidor\\Aplicaciones\\Calidad-MBC\\Documentacion\\DtaosBse',
      'C:\\Users\\MBCPROEW10028\\Downloads\\DtaosBse',
    ].filter((p): p is string => Boolean(p));

    for (const dir of candidates) {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          return dir;
        }
      } catch {
        // Continuar con el siguiente candidato
      }
    }

    throw new Error('No se encontró ningún directorio de archivos históricos accesible.');
  }

  /**
   * Crea una copia instantánea temporal validando que el archivo no cambie durante su lectura.
   * Nunca escribe ni modifica el archivo TXT original.
   */
  private async createVerifiedSnapshot(
    sourceFilePath: string,
    stabilityDelayMs: number,
    simulateInstability: boolean
  ): Promise<{
    snapshotPath: string;
    contentLatin1: string;
    hashSha256: string;
    tamanoBytes: number;
    mtime: Date;
  }> {
    if (!fs.existsSync(sourceFilePath)) {
      throw new Error(`El archivo origen no existe o es inaccesible: ${sourceFilePath}`);
    }

    const stat1 = fs.statSync(sourceFilePath);
    if (stat1.size === 0) {
      throw new Error(`El archivo origen está vacío (0 bytes): ${sourceFilePath}`);
    }

    const buf1 = fs.readFileSync(sourceFilePath);
    const hash1 = crypto.createHash('sha256').update(buf1).digest('hex');

    if (stabilityDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, stabilityDelayMs));
    }

    const stat2 = fs.statSync(sourceFilePath);
    const buf2 = fs.readFileSync(sourceFilePath);
    const hash2 = simulateInstability
      ? 'SIMULATED_CHANGED_HASH_' + Date.now()
      : crypto.createHash('sha256').update(buf2).digest('hex');

    if (stat1.size !== stat2.size || hash1 !== hash2) {
      throw new Error(
        `ARCHIVO_INESTABLE_EN_ESCRITURA: El archivo "${path.basename(
          sourceFilePath
        )}" cambió durante la lectura (hash1=${hash1.slice(0, 12)}, hash2=${hash2.slice(
          0,
          12
        )}). Se cancela para reintentar posteriormente.`
      );
    }

    const tempDir = path.join(os.tmpdir(), 'mbc_legacy_snapshots');
    fs.mkdirSync(tempDir, { recursive: true });
    const snapshotPath = path.join(
      tempDir,
      `${path.basename(sourceFilePath)}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
    );
    fs.writeFileSync(snapshotPath, buf2);

    return {
      snapshotPath,
      contentLatin1: buf2.toString('latin1'),
      hashSha256: hash2,
      tamanoBytes: stat2.size,
      mtime: stat2.mtime,
    };
  }

  /**
   * Fase de Parsing y Validación Estructural FUERA de la transacción MySQL (Condición 6).
   */
  parseAndValidateSnapshot(
    cfg: ArchivoDepartamentoConfig,
    contentLatin1: string,
    defectoClaveSet: Set<number>
  ): {
    validRows: ParsedLegacyRow[];
    rejectedRows: RejectedRowInfo[];
    totalDetected: number;
  } {
    const rawLines = contentLatin1.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (rawLines.length === 0) {
      throw new Error(`ESTRUCTURA_INVALIDA: El archivo ${cfg.archivo} no contiene líneas legibles.`);
    }

    const headerParts = rawLines[0].split('\t').map(h => h.trim());
    if (headerParts[0] !== 'No' || headerParts.length < 10) {
      throw new Error(
        `ESTRUCTURA_INVALIDA: Encabezado corrupto o irreconocible en ${cfg.archivo} ("${rawLines[0].slice(
          0,
          80
        )}").`
      );
    }

    const validRows: ParsedLegacyRow[] = [];
    const rejectedRows: RejectedRowInfo[] = [];
    const seenKeysInFile = new Set<string>();
    const prevNoByYear = new Map<number, number>();
    let totalDetected = 0;

    for (let i = 1; i < rawLines.length; i++) {
      const line = rawLines[i];
      const parts = line.split('\t').map(p => p.trim());
      if (parts[0] === 'No') continue;

      totalDetected++;
      const lineNumber = i + 1;
      const noOriginal = parts[0] || '';

      if (!noOriginal || !/^\d+$/.test(noOriginal)) {
        rejectedRows.push({
          lineNumber,
          noOriginal: noOriginal || 'VACIO',
          motivo: 'NO_ORIGINAL_INVALIDO',
          rawPreview: line.slice(0, 120),
        });
        continue;
      }

      const deptoAuditoriaTexto = parts[1] || cfg.departamentoCodigo;
      if (normalizarTextoCanonico(deptoAuditoriaTexto) === 'ADORNO') {
        rejectedRows.push({
          lineNumber,
          noOriginal,
          motivo: 'DEPARTAMENTO_ADORNO_SEGREGADO',
          rawPreview: line.slice(0, 120),
        });
        continue;
      }

      const fechaTexto = parts[2] || '';
      const fechaParseada = parseFechaLegacy(fechaTexto);
      if (!fechaParseada) {
        rejectedRows.push({
          lineNumber,
          noOriginal,
          motivo: 'FECHA_INVALIDA',
          rawPreview: line.slice(0, 120),
        });
        continue;
      }

      const anioOrigen = fechaParseada.getUTCFullYear();
      const fechaIso = fechaParseada.toISOString().split('T')[0];
      const lista = parts[3] || 'N/A';
      const lote = parts[4] || '';

      // Prohibido inventar lotes sintéticos (LOTE-... o SIN_LOTE)
      if (!lote || lote.toUpperCase().startsWith('LOTE-') || lote.toUpperCase() === 'SIN_LOTE') {
        rejectedRows.push({
          lineNumber,
          noOriginal,
          motivo: 'LOTE_VACIO_O_SINTETICO',
          rawPreview: line.slice(0, 120),
        });
        continue;
      }

      let lineaTexto = '';
      let modelo = '';
      let descripcion = '';
      let defDeptoTexto = '';
      let defectoClave = 0;
      let defectoNombre = '';
      let pares = 1;
      let horma = '';
      let usuarioTexto = '';

      if (cfg.esAviosSinLinea) {
        // En Defectos_Avios.txt la columna Linea está omitida en las filas de datos
        lineaTexto = 'L1';
        modelo = parts[5] || '';
        descripcion = parts[6] || '';
        defDeptoTexto = parts[7] || 'AVIOS';
        defectoClave = parseInt(parts[8] || '', 10) || 0;
        defectoNombre = parts[9] || '';
        pares = parseInt(parts[10] || '', 10) || 0;
        horma = parts[11] || '';
        usuarioTexto = parts[12] || '';
      } else {
        lineaTexto = normalizarLineaCanonico(parts[5] || '');
        modelo = parts[6] || '';
        descripcion = parts[7] || '';
        defDeptoTexto = parts[8] || '';
        defectoClave = parseInt(parts[9] || '', 10) || 0;
        defectoNombre = parts[10] || '';
        pares = parseInt(parts[11] || '', 10) || 0;
        horma = parts[12] || '';
        usuarioTexto = parts[13] || '';
      }

      if (!defectoClave || !defectoClaveSet.has(defectoClave)) {
        rejectedRows.push({
          lineNumber,
          noOriginal,
          motivo: `DEFECTO_NO_EXISTE_EN_CATALOGO:${defectoClave}`,
          rawPreview: line.slice(0, 120),
        });
        continue;
      }

      if (pares <= 0 || Number.isNaN(pares)) {
        rejectedRows.push({
          lineNumber,
          noOriginal,
          motivo: `PARES_INVALIDOS:${pares}`,
          rawPreview: line.slice(0, 120),
        });
        continue;
      }

      // Verificar si hubo un reinicio inesperado de secuencia dentro del mismo año
      const noNumeric = parseInt(noOriginal, 10);
      const prevNo = prevNoByYear.get(anioOrigen) || 0;
      if (noNumeric < prevNo && prevNo - noNumeric > 500) {
        throw new Error(
          `REINICIO_SECUENCIA_MISMO_ANIO: Detectado salto hacia atrás en ${cfg.archivo} año ${anioOrigen} (de No=${prevNo} a No=${noNumeric} en línea ${lineNumber}).`
        );
      }
      prevNoByYear.set(anioOrigen, noNumeric);

      const uniqueFileKey = `${cfg.archivo}|${anioOrigen}|${noOriginal}`;
      if (seenKeysInFile.has(uniqueFileKey)) {
        rejectedRows.push({
          lineNumber,
          noOriginal,
          motivo: `DUPLICADO_EN_MISMO_ARCHIVO:${uniqueFileKey}`,
          rawPreview: line.slice(0, 120),
        });
        continue;
      }
      seenKeysInFile.add(uniqueFileKey);

      const hashFila = calcularHashFilaCanonico({
        archivoOrigen: cfg.archivo,
        anioOrigen,
        noOriginal,
        fechaIso,
        lista,
        lote,
        lineaTexto,
        modelo,
        defDeptoTexto,
        defectoClave,
        pares,
        horma,
        usuarioTexto,
      });

      validRows.push({
        lineNumber,
        archivoOrigen: cfg.archivo,
        anioOrigen,
        noOriginal,
        deptoAuditoriaTexto,
        fechaTexto,
        fechaParseada,
        fechaIso,
        lista,
        lote,
        lineaTexto,
        modelo,
        descripcion,
        defDeptoTexto,
        defectoClave,
        defectoNombre,
        pares,
        horma,
        usuarioTexto,
        hashFila,
      });
    }

    return { validRows, rejectedRows, totalDetected };
  }

  /**
   * Carga el diccionario maestro de lotes desde `Calidad Datos Base.csv` si está disponible.
   */
  private loadMasterLotesCsv(baseDir: string, customCsvPath?: string) {
    const map = new Map<
      string,
      {
        listaLote: string;
        lista: string;
        lote: string;
        idProducto: string;
        modelo: string;
        cantidad: number;
        descripcion: string;
        cliente: string;
        horma: string;
      }
    >();

    const candidates = [
      customCsvPath,
      process.env.LOTES_CSV_PATH,
      path.join(baseDir, 'Calidad Datos Base.csv'),
      'H:\\CALIDAD\\App\\Quality System\\DataBase\\Calidad Datos Base.csv',
      'C:\\Users\\MBCPROEW10028\\Downloads\\DtaosBse\\Calidad Datos Base.csv',
    ].filter((p): p is string => Boolean(p));

    for (const csvPath of candidates) {
      try {
        if (fs.existsSync(csvPath) && fs.statSync(csvPath).size > 0) {
          const content = fs.readFileSync(csvPath, 'utf8');
          const lines = content.trim().split(/\r?\n/);
          for (let i = 1; i < lines.length; i++) {
            const cols = parseCSVLine(lines[i]).map(c => c.trim());
            const listaLote = cols[0] || '';
            const lista = cols[1] || '';
            const lote = cols[2] || '';
            const idProducto = cols[3] || '';
            const cantidad = parseFloat(cols[4]) || 0;
            const descripcion = cols[5] || '';
            const cliente = cols[6] || 'CUADRA PRODUCCIÓN';
            const horma = cols[7] || '';
            if (!lote) continue;
            const modeloExt =
              extraerModelo(idProducto).modelo ||
              (idProducto.length >= 6 ? idProducto.substring(0, 6) : idProducto);
            map.set(lote, {
              listaLote,
              lista: lista || 'N/A',
              lote,
              idProducto: idProducto || modeloExt || 'N/A',
              modelo: modeloExt || 'N/A',
              cantidad,
              descripcion,
              cliente,
              horma,
            });
          }
          break;
        }
      } catch {
        // Ignorar si no es accesible y probar siguiente candidato
      }
    }

    return map;
  }

  /**
   * Ejecuta la sincronización incremental sobre todos los departamentos configurados.
   */
  async syncAll(options: SyncOptions = {}): Promise<FileSyncResult[]> {
    const baseDir = this.resolveBaseDir(options.baseDir);
    const deptosWeb = this.getDepartamentosEnModoWeb(options.departamentosWeb);
    const stabilityDelayMs = options.stabilityDelayMs ?? 50;
    const lockTtlMs = options.lockTtlMs ?? 120_000;

    // Cargar catálogos base de MySQL
    const [departamentosDB, defectosDB, usuariosDB, lineasDB] = await Promise.all([
      prisma.departamento.findMany({ select: { id: true, codigo: true, nombre: true } }),
      prisma.defecto.findMany({ select: { id: true, clave: true, departamentoId: true } }),
      prisma.usuario.findMany({ select: { id: true, usuario: true, nombre: true } }),
      prisma.linea.findMany({ select: { id: true, codigo: true, nombre: true } }),
    ]);

    const deptoMap = new Map<string, number>();
    for (const d of departamentosDB) {
      deptoMap.set(normalizarTextoCanonico(d.codigo).replace(/\s+/g, '_'), d.id);
      deptoMap.set(normalizarTextoCanonico(d.nombre), d.id);
    }
    deptoMap.set('PESPUENTE', deptoMap.get('PESPUNTE') || 4);
    deptoMap.set('BORDADO', deptoMap.get('BORDADO_Y_LASER') || 3);
    deptoMap.set('BORDADO Y LASER', deptoMap.get('BORDADO_Y_LASER') || 3);
    deptoMap.set('PREMONTADO', deptoMap.get('PRELIMINARES') || 2);

    const defectoClaveMap = new Map<number, { id: number; departamentoId: number }>();
    const defectoClaveSet = new Set<number>();
    for (const def of defectosDB) {
      defectoClaveMap.set(def.clave, { id: def.id, departamentoId: def.departamentoId });
      defectoClaveSet.add(def.clave);
    }

    const userMap = new Map<string, number>();
    for (const u of usuariosDB) {
      userMap.set(normalizarUsuarioCanonico(u.nombre), u.id);
      userMap.set(normalizarTextoCanonico(u.usuario), u.id);
    }
    const superAdminId =
      usuariosDB.find(u => u.usuario === 'super.admin' || u.usuario === 'admin')?.id ||
      usuariosDB[0]?.id ||
      1;

    const lineaAccesorioId =
      lineasDB.find(l => l.codigo === 'ACCESORIOS' || l.nombre === 'ACCESORIO')?.id ?? null;

    const lotesCsvMap = this.loadMasterLotesCsv(baseDir, options.lotesCsvPath);

    const configs = options.archivosFiltro
      ? ARCHIVOS_PRODUCCION_LEGACY.filter(c => options.archivosFiltro!.includes(c.archivo))
      : ARCHIVOS_PRODUCCION_LEGACY;

    const results: FileSyncResult[] = [];

    for (const cfg of configs) {
      if (options.shouldAbort) {
        const abortReason = await options.shouldAbort();
        if (abortReason) {
          results.push({
            archivo: cfg.archivo,
            departamento: cfg.departamentoCodigo,
            modo: deptosWeb.has(cfg.departamentoCodigo) ? 'WEB' : 'LEGACY',
            omitidoPorModoWeb: false,
            estado: 'FALLIDO',
            registrosDetectados: 0,
            registrosInsertados: 0,
            registrosActualizados: 0,
            registrosOmitidos: 0,
            registrosRechazados: 0,
            erroresCount: 1,
            rechazos: [],
            mensajeError: abortReason,
          });
          continue;
        }
      }

      const isWeb = deptosWeb.has(cfg.departamentoCodigo);
      if (isWeb) {
        results.push({
          archivo: cfg.archivo,
          departamento: cfg.departamentoCodigo,
          modo: 'WEB',
          omitidoPorModoWeb: true,
          estado: 'OMITIDO_WEB',
          registrosDetectados: 0,
          registrosInsertados: 0,
          registrosActualizados: 0,
          registrosOmitidos: 0,
          registrosRechazados: 0,
          erroresCount: 0,
          rechazos: [],
        });
        continue;
      }

      const fileRes = await this.syncSingleFile({
        cfg,
        baseDir,
        stabilityDelayMs,
        lockTtlMs,
        deptoMap,
        defectoClaveMap,
        defectoClaveSet,
        userMap,
        superAdminId,
        lineaAccesorioId,
        lotesCsvMap,
        simulateInstability: options.simulateInstabilityOnFile === cfg.archivo,
        simulateInterruption: options.simulateInterruptionOnFile === cfg.archivo,
        shouldAbort: options.shouldAbort,
      });

      results.push(fileRes);
    }

    return results;
  }

  /**
   * Sincroniza un archivo individual con bloqueo atómico, validación fuera de transacción
   * y persistencia transaccional en MySQL.
   */
  private async syncSingleFile(params: {
    cfg: ArchivoDepartamentoConfig;
    baseDir: string;
    stabilityDelayMs: number;
    lockTtlMs: number;
    deptoMap: Map<string, number>;
    defectoClaveMap: Map<number, { id: number; departamentoId: number }>;
    defectoClaveSet: Set<number>;
    userMap: Map<string, number>;
    superAdminId: number;
    lineaAccesorioId: number | null;
    lotesCsvMap: Map<
      string,
      {
        listaLote: string;
        lista: string;
        lote: string;
        idProducto: string;
        modelo: string;
        cantidad: number;
        descripcion: string;
        cliente: string;
        horma: string;
      }
    >;
    simulateInstability: boolean;
    simulateInterruption: boolean;
    shouldAbort?: () => Promise<string | null> | string | null;
  }): Promise<FileSyncResult> {
    const { cfg, baseDir, stabilityDelayMs, lockTtlMs } = params;
    const ownerUuid = legacySyncLockService.generateOwnerUuid();

    // 1. Adquirir bloqueo exclusivo por archivo
    const acquired = await legacySyncLockService.acquireLock(cfg.archivo, ownerUuid, lockTtlMs);
    if (!acquired) {
      return {
        archivo: cfg.archivo,
        departamento: cfg.departamentoCodigo,
        modo: 'LEGACY',
        omitidoPorModoWeb: false,
        estado: 'BLOQUEADO',
        registrosDetectados: 0,
        registrosInsertados: 0,
        registrosActualizados: 0,
        registrosOmitidos: 0,
        registrosRechazados: 0,
        erroresCount: 1,
        rechazos: [],
        mensajeError: `El archivo ${cfg.archivo} ya se encuentra bloqueado por otro proceso en ejecución.`,
      };
    }

    let snapshotPath: string | null = null;
    let executionRecordId: number | null = null;
    let executionUuid: string | undefined;

    try {
      const sourcePath = path.join(baseDir, cfg.archivo);

      // Crear registro preliminar de auditoría FUERA de la transacción
      let initialStat = { size: 0, mtime: new Date() };
      if (fs.existsSync(sourcePath)) {
        const st = fs.statSync(sourcePath);
        initialStat = { size: st.size, mtime: st.mtime };
      }

      const execInit = await legacySyncLockService.startExecution({
        archivo: cfg.archivo,
        departamento: cfg.departamentoCodigo,
        hashSha256Archivo: 'PENDING_SNAPSHOT_VERIFICATION',
        tamanoBytes: initialStat.size,
        fechaModificacionTxt: initialStat.mtime,
      });
      executionRecordId = execInit.id;
      executionUuid = execInit.ejecucionUuid;

      // 2. Crear y verificar snapshot estable del archivo TXT
      const snapshot = await this.createVerifiedSnapshot(
        sourcePath,
        stabilityDelayMs,
        params.simulateInstability
      );
      snapshotPath = snapshot.snapshotPath;

      // Actualizar hash real y tamaño del snapshot en el registro de ejecución
      await prisma.controlSincronizacionLegacy.update({
        where: { id: executionRecordId },
        data: {
          hashSha256Archivo: snapshot.hashSha256,
          tamanoBytes: BigInt(snapshot.tamanoBytes),
          fechaModificacionTxt: snapshot.mtime,
        },
      });

      // 3. Parsear y validar estructura y filas FUERA de la transacción de persistencia
      const { validRows, rejectedRows, totalDetected } = this.parseAndValidateSnapshot(
        cfg,
        snapshot.contentLatin1,
        params.defectoClaveSet
      );

      // Renovar bloqueo tras la lectura y validación; abortar si se perdió la propiedad del bloqueo
      const renewedAfterParse = await legacySyncLockService.renewLock(
        cfg.archivo,
        ownerUuid,
        lockTtlMs
      );
      if (!renewedAfterParse) {
        throw new Error(
          `BLOQUEO_PERDIDO_O_EXPIRADO: Se perdió la propiedad del bloqueo de ${cfg.archivo} antes de iniciar la persistencia.`
        );
      }
      if (params.shouldAbort) {
        const abortReason = await params.shouldAbort();
        if (abortReason) {
          throw new Error(abortReason);
        }
      }

      // 4. Consultar estado actual en InspeccionHistoricaOrigen para clasificar filas
      const existingOrigens = await prisma.inspeccionHistoricaOrigen.findMany({
        where: { archivoOrigen: cfg.archivo },
        include: {
          detalle: {
            include: {
              inspeccion: {
                select: {
                  id: true,
                  eliminadoEn: true,
                  procedencia: true,
                },
              },
            },
          },
        },
      });

      const existingMap = new Map<string, (typeof existingOrigens)[number]>();
      for (const ex of existingOrigens) {
        const key = `${ex.archivoOrigen}|${ex.anioOrigen}|${ex.noOriginal}`;
        existingMap.set(key, ex);
      }

      const toInsert: ParsedLegacyRow[] = [];
      const toUpdate: Array<{
        row: ParsedLegacyRow;
        existing: (typeof existingOrigens)[number];
      }> = [];
      let countOmitidos = 0;

      for (const row of validRows) {
        const key = `${row.archivoOrigen}|${row.anioOrigen}|${row.noOriginal}`;
        const existing = existingMap.get(key);
        if (!existing) {
          toInsert.push(row);
        } else if (existing.hashFila === row.hashFila) {
          countOmitidos++;
        } else {
          // Si está eliminado lógicamente en detalle o en cabecera, se protege y nunca se reactiva ni sobrescribe
          const detalleEliminado = Boolean(existing.detalle?.eliminadoEn);
          const cabeceraEliminada = Boolean(existing.detalle?.inspeccion?.eliminadoEn);
          if (detalleEliminado || cabeceraEliminada) {
            countOmitidos++;
            continue;
          }
          toUpdate.push({ row, existing });
        }
      }

      // Si no hay inserciones ni actualizaciones pendientes, finalizar limpiamente sin abrir transacción pesada
      if (toInsert.length === 0 && toUpdate.length === 0) {
        if (params.simulateInterruption) {
          throw new Error(`INTERRUPCION_SIMULADA: Fallo inyectado durante el procesamiento de ${cfg.archivo}`);
        }
        await legacySyncLockService.completeExecution(executionRecordId, {
          registrosDetectados: totalDetected,
          registrosInsertados: 0,
          registrosActualizados: 0,
          registrosOmitidos: countOmitidos,
          registrosRechazados: rejectedRows.length,
          erroresCount: rejectedRows.length,
          detalleErrores: rejectedRows.length > 0 ? { rechazos: rejectedRows.slice(0, 100) } : undefined,
        });

        return {
          archivo: cfg.archivo,
          departamento: cfg.departamentoCodigo,
          modo: 'LEGACY',
          omitidoPorModoWeb: false,
          sincronizacionId: executionRecordId,
          ejecucionUuid: executionUuid,
          estado: 'EXITOSO',
          registrosDetectados: totalDetected,
          registrosInsertados: 0,
          registrosActualizados: 0,
          registrosOmitidos: countOmitidos,
          registrosRechazados: rejectedRows.length,
          erroresCount: rejectedRows.length,
          rechazos: rejectedRows,
        };
      }

      // 5. Ejecutar persistencia atómica dentro de prisma.$transaction
      const deptoAuditoriaId =
        params.deptoMap.get(cfg.departamentoCodigo) ||
        params.deptoMap.get(normalizarTextoCanonico(cfg.departamentoCodigo)) ||
        1;

      await prisma.$transaction(
        async tx => {
          // 5.1. Garantizar que existan los lotes requeridos por las filas nuevas o modificadas
          const neededLotes = new Set<string>();
          for (const r of toInsert) neededLotes.add(r.lote);
          for (const u of toUpdate) neededLotes.add(u.row.lote);

          const neededLotesArr = Array.from(neededLotes);
          const existingLotesDB = await tx.produccionLote.findMany({
            where: { lote: { in: neededLotesArr } },
            select: { id: true, lote: true },
          });
          const loteIdMap = new Map<string, number>(existingLotesDB.map(l => [l.lote, l.id]));

          const missingLotes = neededLotesArr.filter(l => !loteIdMap.has(l));
          if (missingLotes.length > 0) {
            const sampleByLote = new Map<string, ParsedLegacyRow>();
            for (const r of toInsert) {
              if (!sampleByLote.has(r.lote)) sampleByLote.set(r.lote, r);
            }
            for (const u of toUpdate) {
              if (!sampleByLote.has(u.row.lote)) sampleByLote.set(u.row.lote, u.row);
            }

            await tx.produccionLote.createMany({
              data: missingLotes.map(loteCode => {
                const csvInfo = params.lotesCsvMap.get(loteCode);
                const sample = sampleByLote.get(loteCode);
                const lista = csvInfo?.lista || sample?.lista || 'N/A';
                const modelo = csvInfo?.modelo || sample?.modelo || 'N/A';
                return {
                  lote: loteCode.substring(0, 30),
                  listaLote: (csvInfo?.listaLote || `${lista}-${loteCode}`).substring(0, 60),
                  lista: lista.substring(0, 30),
                  idProducto: (csvInfo?.idProducto || modelo).substring(0, 60),
                  modelo: modelo.substring(0, 30),
                  cantidad: csvInfo?.cantidad ?? 0,
                  descripcion: (csvInfo?.descripcion || sample?.descripcion || '').substring(0, 255),
                  cliente: (csvInfo?.cliente || 'CUADRA PRODUCCIÓN').substring(0, 150),
                  horma: (csvInfo?.horma || sample?.horma || '').substring(0, 60),
                  creadoPor: params.superAdminId,
                };
              }),
              skipDuplicates: true,
            });

            const refreshedLotes = await tx.produccionLote.findMany({
              where: { lote: { in: neededLotesArr } },
              select: { id: true, lote: true },
            });
            for (const l of refreshedLotes) {
              loteIdMap.set(l.lote, l.id);
            }
          }

          // Función auxiliar para resolver el inspectorId de una fila
          const resolveInspectorId = (row: ParsedLegacyRow): number => {
            const normUser = normalizarUsuarioCanonico(row.usuarioTexto);
            const found = params.userMap.get(normUser);
            if (found) return found;
            const normAud = normalizarTextoCanonico(row.deptoAuditoriaTexto);
            if (normAud.includes('PESPUNTE')) {
              return params.userMap.get('FRANCISCO ARTURO GONZALEZ') || params.superAdminId;
            }
            if (normAud.includes('ACABADO')) {
              return params.userMap.get('ALEJANDRO GUEVARA') || params.superAdminId;
            }
            if (normAud.includes('MONTADO')) {
              return params.userMap.get('KEVIN ROBERTO CANCINO') || params.superAdminId;
            }
            return params.superAdminId;
          };

          // Función auxiliar para obtener o crear una cabecera LEGACY activa respetando lineaTexto
          const sessionHeaderCache = new Map<string, number>();

          const getOrCreateLegacyHeader = async (row: ParsedLegacyRow, loteId: number): Promise<number> => {
            const inspectorId = resolveInspectorId(row);
            const lineaNorm = normalizarLineaCanonico(row.lineaTexto, cfg.esAviosSinLinea);
            const sessionKey = `${loteId}|${inspectorId}|${deptoAuditoriaId}|${row.fechaIso}|${lineaNorm}`;

            if (sessionHeaderCache.has(sessionKey)) {
              return sessionHeaderCache.get(sessionKey)!;
            }

            const dayStart = new Date(`${row.fechaIso}T00:00:00.000Z`);
            const dayEnd = new Date(`${row.fechaIso}T23:59:59.999Z`);

            const existingHeader = await tx.inspeccionCabecera.findFirst({
              where: {
                procedencia: 'LEGACY',
                loteId,
                inspectorId,
                departamentoAuditoriaId: deptoAuditoriaId,
                lineaTexto: lineaNorm,
                eliminadoEn: null,
                fechaInspeccion: {
                  gte: dayStart,
                  lte: dayEnd,
                },
              },
              select: { id: true },
            });

            if (existingHeader) {
              sessionHeaderCache.set(sessionKey, existingHeader.id);
              return existingHeader.id;
            }

            // Generar un folio único HIST-YYYY-XXXXXXX
            const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
            const folio = `HIST-${row.anioOrigen}-${row.noOriginal.slice(0, 8)}-${randomSuffix}`.substring(
              0,
              30
            );

            const createdHeader = await tx.inspeccionCabecera.create({
              data: {
                folio,
                loteId,
                inspectorId,
                departamentoAuditoriaId: deptoAuditoriaId,
                lineaId: cfg.esAviosSinLinea ? params.lineaAccesorioId : null,
                lineaTexto: lineaNorm,
                horma: row.horma ? row.horma.substring(0, 60) : null,
                fechaInspeccion: row.fechaParseada,
                estado: 'RECHAZADO',
                procedencia: 'LEGACY',
                notas: 'Sesión histórica importada de Access',
                creadoPor: params.superAdminId,
              },
              select: { id: true },
            });

            sessionHeaderCache.set(sessionKey, createdHeader.id);
            return createdHeader.id;
          };

          // 5.2. Procesar filas NUEVAS
          for (const row of toInsert) {
            const loteId = loteIdMap.get(row.lote);
            if (!loteId) continue;

            const defInfo = params.defectoClaveMap.get(row.defectoClave);
            if (!defInfo) continue;

            const normDefDepto = normalizarTextoCanonico(row.defDeptoTexto);
            const defDeptoId =
              params.deptoMap.get(normDefDepto) || defInfo.departamentoId || deptoAuditoriaId;

            const origenCreated = await tx.inspeccionHistoricaOrigen.create({
              data: {
                archivoOrigen: row.archivoOrigen,
                anioOrigen: row.anioOrigen,
                noOriginal: row.noOriginal,
                hashFila: row.hashFila,
                departamento: row.deptoAuditoriaTexto,
                fechaTexto: row.fechaTexto,
                fechaParseada: row.fechaParseada,
                lista: row.lista,
                lote: row.lote,
                linea: row.lineaTexto,
                modelo: row.modelo,
                descripcion: row.descripcion,
                defDepto: row.defDeptoTexto,
                defectoClave: row.defectoClave,
                defectoNombre: row.defectoNombre,
                pares: row.pares,
                horma: row.horma,
                usuarioTexto: row.usuarioTexto,
              },
            });

            const cabeceraId = await getOrCreateLegacyHeader(row, loteId);

            await tx.inspeccionDetalle.create({
              data: {
                inspeccionId: cabeceraId,
                defectoId: defInfo.id,
                defDeptoId,
                paresDefectuosos: row.pares,
                historicoOrigenId: origenCreated.id,
                notas: `No Original: ${row.noOriginal} (${row.archivoOrigen})`.substring(0, 255),
                creadoPor: params.superAdminId,
              },
            });
          }

          // 5.3. Procesar filas MODIFICADAS (con registro en HistoricoModificacionLegacy)
          for (const { row, existing } of toUpdate) {
            const loteId = loteIdMap.get(row.lote);
            if (!loteId) continue;

            const defInfo = params.defectoClaveMap.get(row.defectoClave);
            if (!defInfo) continue;

            const normDefDepto = normalizarTextoCanonico(row.defDeptoTexto);
            const defDeptoId =
              params.deptoMap.get(normDefDepto) || defInfo.departamentoId || deptoAuditoriaId;

            const valoresAnteriores = {
              fechaTexto: existing.fechaTexto,
              lista: existing.lista,
              lote: existing.lote,
              linea: existing.linea,
              modelo: existing.modelo,
              defDepto: existing.defDepto,
              defectoClave: existing.defectoClave,
              defectoNombre: existing.defectoNombre,
              pares: existing.pares,
              horma: existing.horma,
              usuarioTexto: existing.usuarioTexto,
            };

            const valoresNuevos = {
              fechaTexto: row.fechaTexto,
              lista: row.lista,
              lote: row.lote,
              linea: row.lineaTexto,
              modelo: row.modelo,
              defDepto: row.defDeptoTexto,
              defectoClave: row.defectoClave,
              defectoNombre: row.defectoNombre,
              pares: row.pares,
              horma: row.horma,
              usuarioTexto: row.usuarioTexto,
            };

            await tx.historicoModificacionLegacy.create({
              data: {
                historicoOrigenId: existing.id,
                sincronizacionId: executionRecordId!,
                hashAnterior: existing.hashFila,
                hashNuevo: row.hashFila,
                valoresAnteriores,
                valoresNuevos,
              },
            });

            await tx.inspeccionHistoricaOrigen.update({
              where: { id: existing.id },
              data: {
                hashFila: row.hashFila,
                departamento: row.deptoAuditoriaTexto,
                fechaTexto: row.fechaTexto,
                fechaParseada: row.fechaParseada,
                lista: row.lista,
                lote: row.lote,
                linea: row.lineaTexto,
                modelo: row.modelo,
                descripcion: row.descripcion,
                defDepto: row.defDeptoTexto,
                defectoClave: row.defectoClave,
                defectoNombre: row.defectoNombre,
                pares: row.pares,
                horma: row.horma,
                usuarioTexto: row.usuarioTexto,
              },
            });

            if (existing.detalle && !existing.detalle.eliminadoEn) {
              await tx.inspeccionDetalle.update({
                where: { id: existing.detalle.id },
                data: {
                  defectoId: defInfo.id,
                  defDeptoId,
                  paresDefectuosos: row.pares,
                  actualizadoPor: params.superAdminId,
                },
              });
            } else if (!existing.detalle) {
              const cabeceraId = await getOrCreateLegacyHeader(row, loteId);
              await tx.inspeccionDetalle.create({
                data: {
                  inspeccionId: cabeceraId,
                  defectoId: defInfo.id,
                  defDeptoId,
                  paresDefectuosos: row.pares,
                  historicoOrigenId: existing.id,
                  notas: `No Original: ${row.noOriginal} (${row.archivoOrigen})`.substring(0, 255),
                  creadoPor: params.superAdminId,
                },
              });
            }
          }

          // Hook de prueba para simular caída a mitad de la transacción y verificar rollback total
          if (params.simulateInterruption) {
            throw new Error(
              `INTERRUPCION_SIMULADA: Fallo inyectado antes del commit de ${cfg.archivo}`
            );
          }

          // Verificar que el proceso conserva el bloqueo por archivo y el heartbeat global antes de confirmar el commit
          const stillOwnsFileLock = await legacySyncLockService.renewLock(
            cfg.archivo,
            ownerUuid,
            lockTtlMs
          );
          if (!stillOwnsFileLock) {
            throw new Error(
              `BLOQUEO_PERDIDO_O_EXPIRADO: El proceso perdió la propiedad del bloqueo sobre ${cfg.archivo}; abortando transacción.`
            );
          }

          if (params.shouldAbort) {
            const abortReason = await params.shouldAbort();
            if (abortReason) {
              throw new Error(abortReason);
            }
          }
        },
        {
          maxWait: 30_000,
          timeout: 120_000,
        }
      );

      // 6. Marcar ejecución como EXITOSA fuera de la transacción
      await legacySyncLockService.completeExecution(executionRecordId, {
        registrosDetectados: totalDetected,
        registrosInsertados: toInsert.length,
        registrosActualizados: toUpdate.length,
        registrosOmitidos: countOmitidos,
        registrosRechazados: rejectedRows.length,
        erroresCount: rejectedRows.length,
        detalleErrores: rejectedRows.length > 0 ? { rechazos: rejectedRows.slice(0, 100) } : undefined,
      });

      return {
        archivo: cfg.archivo,
        departamento: cfg.departamentoCodigo,
        modo: 'LEGACY',
        omitidoPorModoWeb: false,
        sincronizacionId: executionRecordId,
        ejecucionUuid: executionUuid,
        estado: 'EXITOSO',
        registrosDetectados: totalDetected,
        registrosInsertados: toInsert.length,
        registrosActualizados: toUpdate.length,
        registrosOmitidos: countOmitidos,
        registrosRechazados: rejectedRows.length,
        erroresCount: rejectedRows.length,
        rechazos: rejectedRows,
      };
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      if (executionRecordId) {
        await legacySyncLockService.failExecution(executionRecordId, {
          mensaje: errorMsg,
          timestamp: new Date().toISOString(),
        });
      }
      return {
        archivo: cfg.archivo,
        departamento: cfg.departamentoCodigo,
        modo: 'LEGACY',
        omitidoPorModoWeb: false,
        sincronizacionId: executionRecordId ?? undefined,
        ejecucionUuid: executionUuid,
        estado: 'FALLIDO',
        registrosDetectados: 0,
        registrosInsertados: 0,
        registrosActualizados: 0,
        registrosOmitidos: 0,
        registrosRechazados: 0,
        erroresCount: 1,
        rechazos: [],
        mensajeError: errorMsg,
      };
    } finally {
      if (snapshotPath && fs.existsSync(snapshotPath)) {
        try {
          fs.unlinkSync(snapshotPath);
        } catch {
          // Ignorar error de limpieza de archivo temporal
        }
      }
      await legacySyncLockService.releaseLock(cfg.archivo, ownerUuid);
    }
  }
}

export const legacyIncrementalSyncService = new LegacyIncrementalSyncService();

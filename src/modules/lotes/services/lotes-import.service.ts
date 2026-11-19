import fs from "fs";
import path from "path";
import { prisma } from "../../../config/database";
import { Prisma } from "@prisma/client";
import {
  resolverRutaLotesCSV,
  verificarEstabilidadYAccesoArchivo,
  type FileMetadataResult,
} from "./lotes-file-resolver";
import { syncLogger } from "../../../utils/sync-logger";

export interface ImportLotesOptions {
  filePath?: string;
  usuarioId?: number;
  batchSize?: number;
  strictProduction?: boolean;
  permitirInactivacion?: boolean;
  dryRun?: boolean; // Modo previsualización sin mutar la base de datos
  confirmarReconciliacion?: boolean; // Autorización explícita para reconciliación
  scopeListas?: string[]; // Si se especifica, limita la reconciliación e inactivación exclusivamente a este conjunto de listas (aislamiento para tests)
  debounceMs?: number;
  origenDisparador?: string;
  ejecucionUuid?: string;
}

export interface ImportLotesResult {
  totalLeidos: number;
  insertados: number;
  actualizados: number;
  reactivados: number;
  omitidos: number;
  rechazados: number;
  inactivados: number;
  anomalias: Array<{ fila: number; lote?: string; lista?: string; motivo: string }>;
  errores: Array<{ fila: number; lote?: string; lista?: string; motivo: string }>;
  duracionMs: number;
  archivoUtilizado: string;
  hashSha256?: string;
  tamanoBytes?: number;
  fechaModificacionArchivo?: Date;
  inactivacionEjecutada: boolean;
  inactivacionMotivoOmision?: string;
  dryRun: boolean;
}

/**
 * Parser de líneas CSV compatible con comillas escapadas, saltos de carro y valores delimitados.
 */
export function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      result.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

/**
 * Validador y extractor estricto del campo derivado 'modelo' a partir de IdProducto.
 * Regla oficial: para '103Z2LPH9052CUH', el modelo esperado es '3Z2LPH'.
 * Debe empezar con prefijo '10', longitud mínima 8 y extraer exactamente 6 caracteres.
 */
export function extraerModelo(idProducto: string): { modelo: string | null; error?: string } {
  const clean = idProducto.trim();
  if (!clean) {
    return { modelo: null, error: "IdProducto vacío o no proporcionado" };
  }
  if (!clean.startsWith("10")) {
    return { modelo: null, error: `IdProducto '${clean}' no inicia con prefijo estándar '10'` };
  }
  if (clean.length < 8) {
    return { modelo: null, error: `IdProducto '${clean}' tiene longitud insuficiente (${clean.length} < 8)` };
  }
  const modelo = clean.substring(2, 8).toUpperCase();
  return { modelo };
}

/**
 * Servicio de Reconciliación Robusto, Seguro, Idempotente y Transaccional del Maestro de Lotes.
 *
 * Sincroniza el catálogo de MySQL con el archivo CSV maestro oficial (fuente autoritativa).
 * Identidad única canónica: (lista, lote).
 */
export async function importarLotesDesdeCSV(options: ImportLotesOptions = {}): Promise<ImportLotesResult> {
  const t0 = Date.now();
  const batchSize = options.batchSize || 200;
  const usuarioId = options.usuarioId || null;
  const permitirInactivacion = options.permitirInactivacion ?? true;
  const dryRun = options.dryRun ?? false;

  // 1. Resolver ruta oficial de forma segura
  let filePath: string;
  if (options.filePath) {
    filePath = options.filePath;
  } else {
    filePath = await resolverRutaLotesCSV({
      strictProduction: options.strictProduction,
    });
  }

  // 2. Verificar estabilidad del archivo (Anti-Torn-Write) y calcular hash SHA-256
  const meta: FileMetadataResult = await verificarEstabilidadYAccesoArchivo(
    filePath,
    options.debounceMs ?? 150
  );

  const fileContent = fs.readFileSync(filePath, "utf-8");
  const rawLines = fileContent.trim().split(/\r?\n/);

  if (rawLines.length === 0 || (rawLines.length === 1 && !rawLines[0].trim())) {
    throw new Error(`El archivo CSV '${filePath}' está completamente vacío.`);
  }

  // 3. Validar cabecera requerida de 8 columnas exactas
  const header = parseCSVLine(rawLines[0]).map((h) => h.trim());
  const expectedCols = ["Lista Lote", "Lista", "Lote", "IdProducto", "Cantidad", "Descripcion", "Cliente", "Horma"];
  const isValidHeader =
    header.length === expectedCols.length &&
    expectedCols.every((col, idx) => header[idx] && header[idx].toLowerCase() === col.toLowerCase());

  if (!isValidHeader) {
    throw new Error(
      `La cabecera del CSV no coincide con las 8 columnas esperadas. Esperado: [${expectedCols.join(", ")}]. Recibido: [${header.join(", ")}] en ${filePath}`
    );
  }

  const result: ImportLotesResult = {
    totalLeidos: 0,
    insertados: 0,
    actualizados: 0,
    reactivados: 0,
    omitidos: 0,
    rechazados: 0,
    inactivados: 0,
    anomalias: [],
    errores: [],
    duracionMs: 0,
    archivoUtilizado: filePath,
    hashSha256: meta.sha256,
    tamanoBytes: meta.sizeBytes,
    fechaModificacionArchivo: meta.mtime,
    inactivacionEjecutada: false,
    dryRun,
  };

  // 4. Parseo y validación estructural exhaustiva de cada fila
  interface FilaValida {
    filaNum: number;
    listaLote: string;
    lista: string;
    lote: string;
    idProducto: string;
    modelo: string;
    cantidad: Prisma.Decimal;
    descripcion: string | null;
    cliente: string;
    horma: string | null;
    claveCompuesta: string; // "lista|lote"
  }

  const filasParaProcesar: FilaValida[] = [];
  const clavesCompuestasEnArchivo = new Set<string>();
  const lotesSimplesEnArchivo = new Set<string>();

  for (let i = 1; i < rawLines.length; i++) {
    const filaNum = i + 1;
    const rawLine = rawLines[i].trim();
    if (!rawLine) continue; // Ignorar líneas en blanco intermedias o al final

    result.totalLeidos++;
    const cols = parseCSVLine(rawLines[i]);

    if (cols.length !== 8) {
      result.rechazados++;
      result.errores.push({
        fila: filaNum,
        motivo: `Estructura inválida: esperado 8 columnas, recibido ${cols.length}`,
      });
      continue;
    }

    const listaLoteRaw = cols[0].trim();
    const lista = cols[1].trim();
    const lote = cols[2].trim();
    const idProducto = cols[3].trim();
    const cantidadStr = cols[4].trim();
    const descripcionRaw = cols[5].trim();
    const descripcion = descripcionRaw.length > 0 ? descripcionRaw : null;
    const cliente = cols[6].trim();
    const hormaRaw = cols[7].trim();
    const horma = hormaRaw.length > 0 ? hormaRaw : null;

    // Validación estricta de campos obligatorios
    if (!lista) {
      result.rechazados++;
      result.errores.push({ fila: filaNum, motivo: "El campo 'Lista' es obligatorio y está vacío" });
      continue;
    }

    if (!lote) {
      result.rechazados++;
      result.errores.push({ fila: filaNum, motivo: "El campo 'Lote' es obligatorio y está vacío" });
      continue;
    }

    // Normalizar listaLote canónico: si no viene el prefijo [L], se conserva o se normaliza con el valor textual
    const listaLote = listaLoteRaw.length > 0 ? listaLoteRaw : `[L]${lista}${lote}`;
    const claveCompuesta = `${lista}|${lote}`;

    // Detección de duplicado exacto de Lista + Lote en el mismo archivo
    if (clavesCompuestasEnArchivo.has(claveCompuesta)) {
      result.rechazados++;
      result.errores.push({
        fila: filaNum,
        lista,
        lote,
        motivo: `Combinación duplicada en el mismo archivo CSV: Lista '${lista}' y Lote '${lote}'`,
      });
      continue;
    }
    clavesCompuestasEnArchivo.add(claveCompuesta);

    // Registro de anomalía informativa si el mismo número de lote aparece en otra lista
    if (lotesSimplesEnArchivo.has(lote)) {
      result.anomalias.push({
        fila: filaNum,
        lista,
        lote,
        motivo: `El número de lote '${lote}' aparece en múltiples listas en este CSV (Lista actual: '${lista}'). Se procesa de forma independiente.`,
      });
    }
    lotesSimplesEnArchivo.add(lote);

    // Validación estricta de cantidad numérica decimal (evita "10abc" o valores negativos)
    if (!/^-?\d+(\.\d+)?$/.test(cantidadStr)) {
      result.rechazados++;
      result.errores.push({ fila: filaNum, lista, lote, motivo: `Formato de cantidad decimal inválido: '${cantidadStr}'` });
      continue;
    }

    const cantidadNum = parseFloat(cantidadStr);
    if (isNaN(cantidadNum) || cantidadNum < 0) {
      result.rechazados++;
      result.errores.push({ fila: filaNum, lista, lote, motivo: `Cantidad negativa o no numérica: '${cantidadStr}'` });
      continue;
    }
    const cantidad = new Prisma.Decimal(cantidadStr);

    // Extraer y validar el modelo a partir de IdProducto
    const { modelo, error: modeloErr } = extraerModelo(idProducto);
    if (!modelo || modeloErr) {
      result.rechazados++;
      result.errores.push({
        fila: filaNum,
        lista,
        lote,
        motivo: `Error al derivar modelo de IdProducto '${idProducto}': ${modeloErr}`,
      });
      continue;
    }

    if (!descripcion && cliente.toUpperCase() === "MUESTRAS") {
      result.anomalias.push({
        fila: filaNum,
        lista,
        lote,
        motivo: "Registro de MUESTRAS con descripción vacía preservado fielmente",
      });
    }

    filasParaProcesar.push({
      filaNum,
      listaLote,
      lista,
      lote,
      idProducto,
      modelo,
      cantidad,
      descripcion,
      cliente: cliente || "SIN CLIENTE",
      horma,
      claveCompuesta,
    });
  }

  // 5. GUARDIA CRÍTICA CONTRA CORRUPCIÓN (FAIL-FAST)
  // Si cualquier fila tuvo error estructural o de parseo, NUNCA mutar la base de datos ni inactivar
  if (result.rechazados > 0) {
    result.duracionMs = Date.now() - t0;
    result.inactivacionEjecutada = false;
    result.inactivacionMotivoOmision = `Reconciliación abortada: se detectaron ${result.rechazados} filas con errores estructurales en el CSV.`;

    syncLogger.log({
      proceso: "LOTES_SYNC",
      nivel: "ERROR",
      timestamp: new Date().toISOString(),
      mensaje: `Reconciliación de lotes abortada por fallas estructurales (${result.rechazados} filas inválidas). No se aplicaron cambios.`,
      ejecucionUuid: options.ejecucionUuid,
      origenDisparador: options.origenDisparador || "MANUAL",
      archivo: path.basename(filePath),
      ruta: filePath,
      hashSha256: meta.sha256,
      tamanoBytes: meta.sizeBytes,
      duracionMs: result.duracionMs,
      estado: "FALLIDO",
      metricas: {
        leidos: result.totalLeidos,
        insertados: 0,
        actualizados: 0,
        reactivados: 0,
        omitidos: 0,
        rechazados: result.rechazados,
        inactivados: 0,
      },
      error: `${result.rechazados} filas con error estructural en CSV`,
    });

    throw new Error(
      `El archivo CSV contiene ${result.rechazados} filas con errores estructurales. Se aborta la reconciliación para proteger la base de datos.\n` +
        result.errores.slice(0, 5).map((e) => ` - Fila ${e.fila} [${e.lista || ""}-${e.lote || ""}]: ${e.motivo}`).join("\n")
    );
  }

  // 6. Cargar estado actual de MySQL en memoria de forma optimizada
  // Proyección ligera de todos los lotes de la base de datos
  const lotesEnBD = await prisma.produccionLote.findMany({
    select: {
      id: true,
      listaLote: true,
      lista: true,
      lote: true,
      idProducto: true,
      modelo: true,
      cantidad: true,
      descripcion: true,
      cliente: true,
      horma: true,
      estado: true,
    },
  });

  const mapaBD = new Map<string, (typeof lotesEnBD)[number]>();
  for (const b of lotesEnBD) {
    mapaBD.set(`${b.lista}|${b.lote}`, b);
  }

  // 7. Clasificar operaciones: Insertar vs Actualizar vs Reactivar vs Omitir
  interface OperacionReconciliacion {
    tipo: "INSERT" | "UPDATE" | "REACTIVATE" | "OMIT";
    item: FilaValida;
    existenteId?: number;
  }

  const operaciones: OperacionReconciliacion[] = [];

  for (const item of filasParaProcesar) {
    const existente = mapaBD.get(item.claveCompuesta);

    if (!existente) {
      operaciones.push({ tipo: "INSERT", item });
      result.insertados++;
    } else {
      const eraInactivo = existente.estado === "INACTIVO";
      const mismoListaLote = existente.listaLote === item.listaLote;
      const mismoProducto = existente.idProducto === item.idProducto;
      const mismoModelo = existente.modelo === item.modelo;
      const mismaCantidad = existente.cantidad.equals(item.cantidad);
      const mismaDesc = (existente.descripcion || null) === (item.descripcion || null);
      const mismoCliente = existente.cliente === item.cliente;
      const mismaHorma = (existente.horma || null) === (item.horma || null);

      if (eraInactivo) {
        // Estaba inactivo y vuelve a aparecer en el CSV maestro -> REACTIVAR
        operaciones.push({ tipo: "REACTIVATE", item, existenteId: existente.id });
        result.reactivados++;
      } else if (
        mismoListaLote &&
        mismoProducto &&
        mismoModelo &&
        mismaCantidad &&
        mismaDesc &&
        mismoCliente &&
        mismaHorma
      ) {
        // Datos exactamente idénticos y ya activo -> OMITIR ESCRITURA
        operaciones.push({ tipo: "OMIT", item, existenteId: existente.id });
        result.omitidos++;
      } else {
        // Activo pero con cambios en producto, modelo, cantidad, cliente o descripción -> ACTUALIZAR
        operaciones.push({ tipo: "UPDATE", item, existenteId: existente.id });
        result.actualizados++;
      }
    }
  }

  // 8. Identificar Lotes para Inactivación
  // Todo lote que en MySQL esté ACTIVO pero cuya clave compuesta (lista|lote) NO aparezca en el CSV
  const clavesEnArchivo = clavesCompuestasEnArchivo;
  const lotesParaInactivar: Array<{ id: number; lista: string; lote: string }> = [];

  for (const b of lotesEnBD) {
    if (options.scopeListas && !options.scopeListas.includes(b.lista)) {
      continue;
    }
    if (b.estado === "ACTIVO" && !clavesEnArchivo.has(`${b.lista}|${b.lote}`)) {
      lotesParaInactivar.push({ id: b.id, lista: b.lista, lote: b.lote });
    }
  }

  result.inactivados = lotesParaInactivar.length;

  // 9. Ejecución o Previsualización
  if (dryRun) {
    result.inactivacionEjecutada = false;
    result.inactivacionMotivoOmision = "Modo previsualización (dryRun): cálculo finalizado sin aplicar escrituras en base de datos.";
    result.duracionMs = Date.now() - t0;
    return result;
  }

  // Si no es dryRun, ejecutar la reconciliación transaccional particionada
  const operacionesMutacion = operaciones.filter((op) => op.tipo !== "OMIT");

  for (let i = 0; i < operacionesMutacion.length; i += batchSize) {
    const chunk = operacionesMutacion.slice(i, i + batchSize);

    await prisma.$transaction(async (tx) => {
      for (const op of chunk) {
        if (op.tipo === "INSERT") {
          await tx.produccionLote.create({
            data: {
              listaLote: op.item.listaLote,
              lista: op.item.lista,
              lote: op.item.lote,
              idProducto: op.item.idProducto,
              modelo: op.item.modelo,
              cantidad: op.item.cantidad,
              descripcion: op.item.descripcion,
              cliente: op.item.cliente,
              horma: op.item.horma,
              creadoPor: usuarioId,
              estado: "ACTIVO",
            },
          });
        } else if (op.tipo === "REACTIVATE" || op.tipo === "UPDATE") {
          await tx.produccionLote.update({
            where: { id: op.existenteId! },
            data: {
              listaLote: op.item.listaLote,
              lista: op.item.lista,
              idProducto: op.item.idProducto,
              modelo: op.item.modelo,
              cantidad: op.item.cantidad,
              descripcion: op.item.descripcion,
              cliente: op.item.cliente,
              horma: op.item.horma,
              estado: "ACTIVO",
              actualizadoPor: usuarioId,
            },
          });
        }
      }
    });
  }

  // 10. Aplicar Inactivaciones Masivas Deterministas por ID primario
  if (permitirInactivacion && lotesParaInactivar.length > 0) {
    const idsInactivar = lotesParaInactivar.map((l) => l.id);

    for (let i = 0; i < idsInactivar.length; i += batchSize) {
      const chunkIds = idsInactivar.slice(i, i + batchSize);
      await prisma.produccionLote.updateMany({
        where: { id: { in: chunkIds } },
        data: {
          estado: "INACTIVO",
          actualizadoPor: usuarioId,
        },
      });
    }

    result.inactivacionEjecutada = true;
  } else if (!permitirInactivacion) {
    result.inactivacionEjecutada = false;
    result.inactivacionMotivoOmision = "Inactivación deshabilitada por configuración explícita.";
  } else {
    result.inactivacionEjecutada = true;
  }

  result.duracionMs = Date.now() - t0;

  // Registrar en el log estructurado de sincronización
  syncLogger.log({
    proceso: "LOTES_SYNC",
    nivel: result.errores.length > 0 ? "WARN" : "INFO",
    timestamp: new Date().toISOString(),
    mensaje: `Reconciliación de lotes finalizada: ${result.insertados} insertados, ${result.actualizados} actualizados, ${result.reactivados} reactivados, ${result.omitidos} omitidos, ${result.inactivados} inactivados, ${result.rechazados} rechazados.`,
    ejecucionUuid: options.ejecucionUuid,
    origenDisparador: options.origenDisparador || "MANUAL",
    archivo: path.basename(filePath),
    ruta: filePath,
    hashSha256: meta.sha256,
    tamanoBytes: meta.sizeBytes,
    duracionMs: result.duracionMs,
    estado: "EXITOSO",
    metricas: {
      leidos: result.totalLeidos,
      insertados: result.insertados,
      actualizados: result.actualizados,
      reactivados: result.reactivados,
      omitidos: result.omitidos,
      rechazados: result.rechazados,
      inactivados: result.inactivados,
    },
    detalleTecnico: {
      inactivacionEjecutada: result.inactivacionEjecutada,
      inactivacionMotivoOmision: result.inactivacionMotivoOmision,
      anomaliasCount: result.anomalias.length,
      dryRun: result.dryRun,
    },
  });

  return result;
}

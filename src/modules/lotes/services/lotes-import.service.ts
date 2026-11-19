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
  debounceMs?: number;
  origenDisparador?: string;
  ejecucionUuid?: string;
}

export interface ImportLotesResult {
  totalLeidos: number;
  insertados: number;
  actualizados: number;
  omitidos: number;
  rechazados: number;
  inactivados: number;
  anomalias: Array<{ fila: number; lote?: string; motivo: string }>;
  errores: Array<{ fila: number; lote?: string; motivo: string }>;
  duracionMs: number;
  archivoUtilizado: string;
  hashSha256?: string;
  tamanoBytes?: number;
  fechaModificacionArchivo?: Date;
  inactivacionEjecutada: boolean;
  inactivacionMotivoOmision?: string;
}

/**
 * Parser de líneas CSV compatible con comillas escapadas y saltos de carro.
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
 * Servicio de importación robusto, seguro, idempotente y transaccional del maestro de lotes.
 */
export async function importarLotesDesdeCSV(options: ImportLotesOptions = {}): Promise<ImportLotesResult> {
  const t0 = Date.now();
  const batchSize = options.batchSize || 100;
  const usuarioId = options.usuarioId || null;
  const permitirInactivacion = options.permitirInactivacion ?? true;

  // 1. Resolver ruta oficial de forma segura (sin fallback obsoleto en modo estricto)
  let filePath: string;
  if (options.filePath) {
    filePath = options.filePath;
  } else {
    filePath = await resolverRutaLotesCSV({
      strictProduction: options.strictProduction,
    });
  }

  // 2. Verificar estabilidad del archivo (Anti-Torn-Write) y calcular hash
  const meta: FileMetadataResult = await verificarEstabilidadYAccesoArchivo(
    filePath,
    options.debounceMs ?? 150
  );

  const fileContent = fs.readFileSync(filePath, "utf-8");
  const rawLines = fileContent.trim().split(/\r?\n/);

  if (rawLines.length === 0) {
    throw new Error(`El archivo CSV '${filePath}' está completamente vacío.`);
  }

  // 3. Validar cabecera requerida de 8 columnas
  const header = parseCSVLine(rawLines[0]).map((h) => h.trim());
  const expectedCols = ["Lista Lote", "Lista", "Lote", "IdProducto", "Cantidad", "Descripcion", "Cliente", "Horma"];
  const isValidHeader = expectedCols.every(
    (col, idx) => header[idx] && header[idx].toLowerCase() === col.toLowerCase()
  );

  if (!isValidHeader) {
    throw new Error(
      `La cabecera del CSV no coincide con las 8 columnas esperadas. Recibido: [${header.join(", ")}] en ${filePath}`
    );
  }

  const result: ImportLotesResult = {
    totalLeidos: 0,
    insertados: 0,
    actualizados: 0,
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
  };

  // 4. Parseo y validación de filas individuales
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
    if (!rawLine) continue;

    result.totalLeidos++;
    const cols = parseCSVLine(rawLines[i]);

    if (cols.length !== 8) {
      result.rechazados++;
      result.errores.push({
        fila: filaNum,
        motivo: `Número de columnas inválido: esperado 8, obtenido ${cols.length}`,
      });
      continue;
    }

    const listaLote = cols[0].trim();
    const lista = cols[1].trim();
    const lote = cols[2].trim();
    const idProducto = cols[3].trim();
    const cantidadStr = cols[4].trim();
    const descripcionRaw = cols[5].trim();
    const descripcion = descripcionRaw.length > 0 ? descripcionRaw : null;
    const cliente = cols[6].trim();
    const hormaRaw = cols[7].trim();
    const horma = hormaRaw.length > 0 ? hormaRaw : null;

    if (!lote) {
      result.rechazados++;
      result.errores.push({ fila: filaNum, motivo: "El campo 'Lote' es obligatorio y está vacío" });
      continue;
    }

    const claveCompuesta = `${lista}|${lote}`;

    // Detección de duplicado exacto de Lista + Lote en el mismo archivo
    if (clavesCompuestasEnArchivo.has(claveCompuesta)) {
      result.rechazados++;
      result.errores.push({
        fila: filaNum,
        lote,
        motivo: `Combinación Lista '${lista}' y Lote '${lote}' duplicada dentro del mismo archivo CSV`,
      });
      continue;
    }
    clavesCompuestasEnArchivo.add(claveCompuesta);

    // Registro de anomalía informativa si el mismo lote aparece en listas diferentes
    if (lotesSimplesEnArchivo.has(lote)) {
      result.anomalias.push({
        fila: filaNum,
        lote,
        motivo: `El número de lote '${lote}' aparece en múltiples listas en el mismo archivo CSV (Lista actual: '${lista}')`,
      });
    }
    lotesSimplesEnArchivo.add(lote);

    const cantidadNum = parseFloat(cantidadStr);
    if (isNaN(cantidadNum) || cantidadNum < 0) {
      result.rechazados++;
      result.errores.push({ fila: filaNum, lote, motivo: `Cantidad decimal inválida: '${cantidadStr}'` });
      continue;
    }
    const cantidad = new Prisma.Decimal(cantidadStr);

    const { modelo, error: modeloErr } = extraerModelo(idProducto);
    if (!modelo || modeloErr) {
      result.rechazados++;
      result.errores.push({
        fila: filaNum,
        lote,
        motivo: `Error al derivar modelo de IdProducto '${idProducto}': ${modeloErr}`,
      });
      continue;
    }

    if (!descripcion && cliente.toUpperCase() === "MUESTRAS") {
      result.anomalias.push({
        fila: filaNum,
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

  // 5. Cargar registros existentes en MySQL para clasificación idempotente
  // Buscamos por lotes y listaLote para mapear por clave compuesta (lista|lote)
  const lotesCodigos = filasParaProcesar.map((f) => f.lote);
  const lotesExistentes = await prisma.produccionLote.findMany({
    where: { lote: { in: lotesCodigos } },
    select: {
      id: true,
      lote: true,
      listaLote: true,
      lista: true,
      idProducto: true,
      modelo: true,
      cantidad: true,
      descripcion: true,
      cliente: true,
      horma: true,
      estado: true,
    },
  });

  // Mapa primario por combinación lista|lote; mapa secundario por lote
  const mapaPorClaveCompuesta = new Map<string, (typeof lotesExistentes)[number]>();
  const mapaPorLoteSimple = new Map<string, (typeof lotesExistentes)[number]>();

  for (const e of lotesExistentes) {
    mapaPorClaveCompuesta.set(`${e.lista}|${e.lote}`, e);
    if (!mapaPorLoteSimple.has(e.lote)) {
      mapaPorLoteSimple.set(e.lote, e);
    }
  }

  // 6. Procesamiento particionado en bloques transaccionales
  for (let i = 0; i < filasParaProcesar.length; i += batchSize) {
    const chunk = filasParaProcesar.slice(i, i + batchSize);

    await prisma.$transaction(async (tx) => {
      for (const item of chunk) {
        // Coincidencia preferente: Lista + Lote exacto
        let existente = mapaPorClaveCompuesta.get(item.claveCompuesta);

        // Si no coincide por Lista+Lote pero sí por lote único (compatibilidad con esquema previo)
        if (!existente) {
          existente = mapaPorLoteSimple.get(item.lote);
        }

        if (!existente) {
          // INSERTAR NUEVO REGISTRO
          try {
            const nuevo = await tx.produccionLote.create({
              data: {
                listaLote: item.listaLote,
                lista: item.lista,
                lote: item.lote,
                idProducto: item.idProducto,
                modelo: item.modelo,
                cantidad: item.cantidad,
                descripcion: item.descripcion,
                cliente: item.cliente,
                horma: item.horma,
                creadoPor: usuarioId,
                estado: "ACTIVO",
              },
            });
            mapaPorClaveCompuesta.set(item.claveCompuesta, nuevo);
            mapaPorLoteSimple.set(item.lote, nuevo);
            result.insertados++;
          } catch (createErr: any) {
            // Protección si la base de datos aún tiene UNIQUE(lote) estricto y colisiona
            if (createErr.code === "P2002") {
              result.rechazados++;
              result.errores.push({
                fila: item.filaNum,
                lote: item.lote,
                motivo: `Colisión de unicidad en base de datos para lote '${item.lote}' (requiere migración a UNIQUE(lista, lote)): ${createErr.message}`,
              });
            } else {
              throw createErr;
            }
          }
        } else {
          // COMPROBAR IDEMPOTENCIA (Si los campos son idénticos, no tocar el registro)
          const mismoListaLote = existente.listaLote === item.listaLote;
          const mismaLista = existente.lista === item.lista;
          const mismoProducto = existente.idProducto === item.idProducto;
          const mismoModelo = existente.modelo === item.modelo;
          const mismaCantidad = existente.cantidad.equals(item.cantidad);
          const mismaDesc = (existente.descripcion || null) === (item.descripcion || null);
          const mismoCliente = existente.cliente === item.cliente;
          const mismaHorma = (existente.horma || null) === (item.horma || null);
          const mismoEstado = existente.estado === "ACTIVO";

          if (
            mismoListaLote &&
            mismaLista &&
            mismoProducto &&
            mismoModelo &&
            mismaCantidad &&
            mismaDesc &&
            mismoCliente &&
            mismaHorma &&
            mismoEstado
          ) {
            result.omitidos++;
          } else {
            // ACTUALIZACIÓN DE DATOS MAESTROS (Conserva el mismo ID)
            await tx.produccionLote.update({
              where: { id: existente.id },
              data: {
                listaLote: item.listaLote,
                lista: item.lista,
                idProducto: item.idProducto,
                modelo: item.modelo,
                cantidad: item.cantidad,
                descripcion: item.descripcion,
                cliente: item.cliente,
                horma: item.horma,
                estado: "ACTIVO",
                actualizadoPor: usuarioId,
              },
            });
            result.actualizados++;
          }
        }
      }
    });
  }

  // 7. GUARDIA CRÍTICA CONTRA INACTIVACIÓN MASIVA ACCIDENTAL
  // Regla: Nunca inactivar si el archivo tuvo errores de rechazo o si el volumen
  // es inferior al 50% de los lotes actualmente activos en la base de datos.
  if (permitirInactivacion) {
    const lotesActivosEnBDCount = await prisma.produccionLote.count({
      where: { estado: "ACTIVO" },
    });

    const umbralMinimo = Math.floor(lotesActivosEnBDCount * 0.5);

    if (result.rechazados > 0) {
      result.inactivacionEjecutada = false;
      result.inactivacionMotivoOmision = `Inactivación omitida: el archivo tuvo ${result.rechazados} filas rechazadas. Se previene inactivar datos legítimos ante posibles fallas de formato.`;
    } else if (filasParaProcesar.length < umbralMinimo && lotesActivosEnBDCount > 100) {
      result.inactivacionEjecutada = false;
      result.inactivacionMotivoOmision = `Inactivación omitida por umbral de seguridad: el CSV contiene solo ${filasParaProcesar.length} filas frente a ${lotesActivosEnBDCount} lotes activos en BD (< 50%). Podría ser un archivo truncado o de subconjunto.`;
    } else {
      const lotesEnArchivoArr = filasParaProcesar.map((f) => f.lote);
      const inactivadosRes = await prisma.produccionLote.updateMany({
        where: {
          lote: { notIn: lotesEnArchivoArr },
          estado: "ACTIVO",
        },
        data: {
          estado: "INACTIVO",
          actualizadoPor: usuarioId,
        },
      });

      result.inactivados = inactivadosRes.count;
      result.inactivacionEjecutada = true;
    }
  } else {
    result.inactivacionEjecutada = false;
    result.inactivacionMotivoOmision = "Inactivación deshabilitada por configuración explícita.";
  }

  result.duracionMs = Date.now() - t0;

  // Registrar en el log estructurado de sincronización
  syncLogger.log({
    proceso: "LOTES_SYNC",
    nivel: result.errores.length > 0 ? "WARN" : "INFO",
    timestamp: new Date().toISOString(),
    mensaje: `Importación de lotes finalizada: ${result.insertados} insertados, ${result.actualizados} actualizados, ${result.omitidos} omitidos, ${result.inactivados} inactivados, ${result.rechazados} rechazados.`,
    ejecucionUuid: options.ejecucionUuid,
    origenDisparador: options.origenDisparador || "MANUAL",
    archivo: path.basename(filePath),
    ruta: filePath,
    hashSha256: meta.sha256,
    tamanoBytes: meta.sizeBytes,
    duracionMs: result.duracionMs,
    estado: result.rechazados > 0 && result.insertados === 0 ? "FALLIDO" : "EXITOSO",
    metricas: {
      leidos: result.totalLeidos,
      insertados: result.insertados,
      actualizados: result.actualizados,
      omitidos: result.omitidos,
      rechazados: result.rechazados,
      inactivados: result.inactivados,
    },
    error: result.errores.length > 0 ? `${result.errores.length} filas con error` : null,
    detalleTecnico: {
      inactivacionEjecutada: result.inactivacionEjecutada,
      inactivacionMotivoOmision: result.inactivacionMotivoOmision,
      anomaliasCount: result.anomalias.length,
    },
  });

  return result;
}

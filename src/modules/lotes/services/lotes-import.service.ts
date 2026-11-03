import fs from "fs";
import path from "path";
import { prisma } from "../../../config/database";
import { Prisma } from "@prisma/client";

export interface ImportLotesOptions {
  filePath?: string;
  usuarioId?: number;
  batchSize?: number;
}

export interface ImportLotesResult {
  totalLeidos: number;
  insertados: number;
  actualizados: number;
  omitidos: number;
  rechazados: number;
  anomalias: Array<{ fila: number; lote?: string; motivo: string }>;
  errores: Array<{ fila: number; lote?: string; motivo: string }>;
  duracionMs: number;
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
 * Regla oficial observada: para '103Z2LPH9052CUH', el modelo esperado es '3Z2LPH'.
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
 * Servicio de importación idempotente y transaccional del maestro de lotes.
 */
export async function importarLotesDesdeCSV(options: ImportLotesOptions = {}): Promise<ImportLotesResult> {
  const t0 = Date.now();
  const defaultPath = "C:/Users/MBCPROEW10028/Downloads/DtaosBse/Calidad Datos Base.csv";
  const filePath = options.filePath || defaultPath;
  const batchSize = options.batchSize || 100;
  const usuarioId = options.usuarioId || null;

  if (!fs.existsSync(filePath)) {
    throw new Error(`El archivo CSV fuente no existe en la ruta: ${filePath}`);
  }

  const fileContent = fs.readFileSync(filePath, "utf-8");
  const rawLines = fileContent.trim().split(/\r?\n/);

  if (rawLines.length === 0) {
    throw new Error("El archivo CSV está completamente vacío");
  }

  // 1. Validar cabecera requerida
  const header = parseCSVLine(rawLines[0]).map((h) => h.trim());
  const expectedCols = ["Lista Lote", "Lista", "Lote", "IdProducto", "Cantidad", "Descripcion", "Cliente", "Horma"];
  const isValidHeader = expectedCols.every((col, idx) => header[idx] && header[idx].toLowerCase() === col.toLowerCase());

  if (!isValidHeader) {
    throw new Error(`La cabecera del CSV no coincide con las 8 columnas esperadas. Recibido: ${header.join(", ")}`);
  }

  const result: ImportLotesResult = {
    totalLeidos: 0,
    insertados: 0,
    actualizados: 0,
    omitidos: 0,
    rechazados: 0,
    anomalias: [],
    errores: [],
    duracionMs: 0,
  };

  // 2. Parseo y validación de filas individuales
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
  }

  const filasParaProcesar: FilaValida[] = [];
  const lotesEnArchivo = new Set<string>();

  for (let i = 1; i < rawLines.length; i++) {
    const filaNum = i + 1;
    const rawLine = rawLines[i].trim();
    if (!rawLine) continue; // Ignorar líneas en blanco al final

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
    // Conservar descripción vacía tal como viene en el CSV (ej. MUESTRAS), sin inventar texto
    const descripcionRaw = cols[5].trim();
    const descripcion = descripcionRaw.length > 0 ? descripcionRaw : null;
    const cliente = cols[6].trim();
    const hormaRaw = cols[7].trim();
    const horma = hormaRaw.length > 0 ? hormaRaw : null;

    // Validar lote obligatorio
    if (!lote) {
      result.rechazados++;
      result.errores.push({ fila: filaNum, motivo: "El campo 'Lote' es obligatorio y está vacío" });
      continue;
    }

    // Detección de duplicados internos dentro del mismo archivo CSV
    if (lotesEnArchivo.has(lote)) {
      result.rechazados++;
      result.errores.push({ fila: filaNum, lote, motivo: `Lote '${lote}' duplicado dentro del mismo archivo CSV` });
      continue;
    }
    lotesEnArchivo.add(lote);

    // Validar y convertir Cantidad decimal sin pérdida de ceros ni precisión
    const cantidadNum = parseFloat(cantidadStr);
    if (isNaN(cantidadNum) || cantidadNum < 0) {
      result.rechazados++;
      result.errores.push({ fila: filaNum, lote, motivo: `Cantidad decimal inválida: '${cantidadStr}'` });
      continue;
    }
    const cantidad = new Prisma.Decimal(cantidadStr);

    // Extraer y validar el modelo derivado a partir de IdProducto
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

    // Registro de anomalías no bloqueantes (ej. MUESTRAS con descripción vacía)
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
    });
  }

  // 3. Procesamiento en lotes transaccionales de MySQL (idempotente)
  // Obtenemos todos los lotes existentes en BD para clasificar inserciones vs actualizaciones vs omitidos
  const lotesIds = filasParaProcesar.map((f) => f.lote);
  const lotesExistentes = await prisma.produccionLote.findMany({
    where: { lote: { in: lotesIds } },
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

  const mapaExistentes = new Map(lotesExistentes.map((e) => [e.lote, e]));

  // Particionar en bloques de batchSize para no saturar transacciones
  for (let i = 0; i < filasParaProcesar.length; i += batchSize) {
    const chunk = filasParaProcesar.slice(i, i + batchSize);

    await prisma.$transaction(async (tx) => {
      for (const item of chunk) {
        const existente = mapaExistentes.get(item.lote);

        if (!existente) {
          // INSERTAR NUEVO REGISTRO
          await tx.produccionLote.create({
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
          result.insertados++;
        } else {
          // COMPROBAR SI CAMBIÓ ALGÚN DATO (IDEMPOTENCIA)
          const mismoListaLote = existente.listaLote === item.listaLote;
          const mismaLista = existente.lista === item.lista;
          const mismoProducto = existente.idProducto === item.idProducto;
          const mismoModelo = existente.modelo === item.modelo;
          const mismaCantidad = existente.cantidad.equals(item.cantidad);
          const mismaDesc = (existente.descripcion || null) === (item.descripcion || null);
          const mismoCliente = existente.cliente === item.cliente;
          const mismaHorma = (existente.horma || null) === (item.horma || null);
          const mismoEstado = existente.estado === "ACTIVO";

          if (mismoListaLote && mismaLista && mismoProducto && mismoModelo && mismaCantidad && mismaDesc && mismoCliente && mismaHorma && mismoEstado) {
            // IDÉNTICO: No tocar para respetar auditoría y precedencia
            result.omitidos++;
          } else {
            // ACTUALIZACIÓN DE DATOS MAESTROS
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

  // 4. Los lotes que ya NO vengan en el archivo maestro de producción pasan a INACTIVO
  const lotesActivosEnArchivo = filasParaProcesar.map((f) => f.lote);
  if (lotesActivosEnArchivo.length > 0) {
    const inactivados = await prisma.produccionLote.updateMany({
      where: {
        lote: { notIn: lotesActivosEnArchivo },
        estado: "ACTIVO",
      },
      data: {
        estado: "INACTIVO",
        actualizadoPor: usuarioId,
      },
    });
    if (inactivados.count > 0) {
      console.log(`ℹ️ [Lotes] Se marcaron ${inactivados.count} lotes como INACTIVO al no estar en el archivo maestro actual.`);
    }
  }

  result.duracionMs = Date.now() - t0;
  return result;
}

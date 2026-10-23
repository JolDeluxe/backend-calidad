import fs from 'fs';

const filePath = 'C:/Users/MBCPROEW10028/Downloads/DtaosBse/Calidad Datos Base.csv';
const content = fs.readFileSync(filePath, 'utf-8');
const lines = content.trim().split(/\r?\n/);
console.log('Total lineas en CSV:', lines.length);

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
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
    } else if (c === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

const header = parseCSVLine(lines[0]);
console.log('Encabezados:', header);

const rows = lines.slice(1).map((l, idx) => ({ lineNum: idx + 2, raw: l, fields: parseCSVLine(l) }));
console.log('Filas de datos:', rows.length);

// Verificar número de columnas
const badCols = rows.filter(r => r.fields.length !== 8);
console.log('Filas con número de columnas distinto de 8:', badCols.length);

const lotesSet = new Set<string>();
const duplicateLotes: string[] = [];
const listaLoteSet = new Set<string>();

for (const r of rows) {
  const [listaLote, lista, lote, idProducto, cantidad, descripcion, cliente, horma] = r.fields;
  if (lotesSet.has(lote)) {
    duplicateLotes.push(lote);
  }
  lotesSet.add(lote);
  listaLoteSet.add(listaLote);
}

console.log('Lotes unicos:', lotesSet.size);
console.log('Lotes duplicados:', duplicateLotes);
console.log('ListaLote unicos:', listaLoteSet.size);

// Analisis de IdProducto y regla de extraccion de Modelo
// IdProducto ejemplo: 103Z2LPH9052CUH -> modelo esperado: 3Z2LPH (indices 2 a 8, longitud 6)
let validModelCount = 0;
let invalidModelCount = 0;
const invalidExamples: any[] = [];

for (const r of rows) {
  const idProducto = r.fields[3].trim();
  // Validacion de IdProducto:
  // Si empieza con 10 y tiene longitud al menos 8
  if (idProducto.startsWith('10') && idProducto.length >= 8) {
    const modelo = idProducto.substring(2, 8);
    validModelCount++;
  } else {
    invalidModelCount++;
    invalidExamples.push({ line: r.lineNum, idProducto });
  }
}

console.log('Modelos validos extraidos (con idProducto empezando en 10):', validModelCount);
console.log('Modelos anomalos / invalidos:', invalidModelCount);
if (invalidExamples.length > 0) {
  console.log('Ejemplos de idProducto no estandar:', invalidExamples);
}

// Analisis de Cantidades
let cantParseErrors = 0;
for (const r of rows) {
  const cantStr = r.fields[4].trim();
  const num = parseFloat(cantStr);
  if (isNaN(num)) cantParseErrors++;
}
console.log('Errores en cantidad decimal:', cantParseErrors);

// Analisis de Descripciones vacias (muestras)
const vacias = rows.filter(r => !r.fields[5].trim());
console.log('Filas con descripcion vacia:', vacias.length);
console.log('Clientes en descripcion vacia:', Array.from(new Set(vacias.map(r => r.fields[6].trim()))));

// Analisis de Hormas
const hormas = Array.from(new Set(rows.map(r => r.fields[7].trim())));
console.log('Cantidad de hormas distintas:', hormas.length);
console.log('Ejemplos de hormas:', hormas.slice(0, 10));

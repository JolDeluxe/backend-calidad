import fs from 'fs';
import path from 'path';

const H_DIR = 'H:\\CALIDAD\\App\\Quality System\\DataBase';
const CSV_FILE = path.join(H_DIR, 'historico_general_49k.csv');

const TXT_FILES = [
  'Defectos_Acabado.txt',
  'Defectos_Avios.txt',
  'Defectos_Bordado.txt',
  'Defectos_corte.txt',
  'Defectos_Montado.txt',
  'Defectos_Pespunte.txt',
  'Defectos_Preliminares.txt',
];

interface CsvRecord {
  id: string;
  noOriginal: string;
  deptoAuditoria: string;
  fechaTexto: string;
  fechaEstandar: string;
  lista: string;
  lote: string;
  linea: string;
  modelo: string;
  descripcion: string;
  deptoResponsable: string;
  claveDefecto: string;
  nombreDefecto: string;
  pares: string;
  horma: string;
  usuario: string;
  archivoOrigen: string;
}

function parseCsvSimple(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += char;
    }
  }
  result.push(cur);
  return result;
}

function normalizarTexto(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

function normalizarLineaTexto(val: string): string {
  if (!val) return 'L1';
  const v = val.trim().toUpperCase();
  if (v === 'L1') return 'L1';
  if (v === 'L2') return 'L2';
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

async function runAudit() {
  console.log('========================================================================');
  console.log('AUDITORÍA COMPARATIVA: ARCHIVOS TXT VS CSV EXPORTADO (49k)');
  console.log('========================================================================\n');

  // 1. Leer y analizar CSV exportado
  console.log('1. Leyendo CSV generado:', CSV_FILE);
  const csvRaw = fs.readFileSync(CSV_FILE, 'utf8').replace(/^\ufeff/, '');
  const csvLines = csvRaw.split(/\r?\n/).filter(l => l.trim().length > 0);
  console.log(`   -> Total líneas en CSV (incluyendo encabezado): ${csvLines.length.toLocaleString()}`);

  const csvRows: CsvRecord[] = [];
  const csvByArchivo = new Map<string, number>();

  for (let i = 1; i < csvLines.length; i++) {
    const cols = parseCsvSimple(csvLines[i]);
    const rec: CsvRecord = {
      id: cols[0],
      noOriginal: cols[1],
      deptoAuditoria: cols[2],
      fechaTexto: cols[3],
      fechaEstandar: cols[4],
      lista: cols[5],
      lote: cols[6],
      linea: cols[7],
      modelo: cols[8],
      descripcion: cols[9],
      deptoResponsable: cols[10],
      claveDefecto: cols[11],
      nombreDefecto: cols[12],
      pares: cols[13],
      horma: cols[14],
      usuario: cols[15],
      archivoOrigen: cols[16],
    };
    csvRows.push(rec);
    csvByArchivo.set(rec.archivoOrigen, (csvByArchivo.get(rec.archivoOrigen) || 0) + 1);
  }
  console.log(`   -> Total registros de datos en CSV: ${csvRows.length.toLocaleString()}\n`);

  // 2. Analizar cada archivo TXT plano
  console.log('2. Comparando archivo por archivo contra los TXT originales:\n');

  let totalTxtValidos = 0;
  let totalTxtOmitidos = 0;
  const txtCounts = new Map<string, { totalLineas: number; validas: number; omitidas: number; detalleOmitidas: string[] }>();

  for (const file of TXT_FILES) {
    const filePath = path.join(H_DIR, file);
    if (!fs.existsSync(filePath)) {
      console.error(`   [ERROR] Archivo no existe: ${filePath}`);
      continue;
    }

    const content = fs.readFileSync(filePath, 'latin1');
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    const isAvios = file === 'Defectos_Avios.txt';

    let validas = 0;
    let omitidas = 0;
    const detalleOmitidas: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split('\t').map(p => p.trim());
      if (parts[0] === 'No') continue; // Encabezado

      const deptoAuditNorm = normalizarTexto(parts[1] || '');
      if (deptoAuditNorm === 'ADORNO') {
        omitidas++;
        detalleOmitidas.push(`Línea ${i + 1}: Departamento ADORNO`);
        continue;
      }

      let lote = parts[4] || '';
      let defectoClave = 0;

      if (isAvios) {
        defectoClave = parseInt(parts[8], 10) || 0;
      } else {
        defectoClave = parseInt(parts[9], 10) || 0;
      }

      if (!lote || !defectoClave) {
        omitidas++;
        detalleOmitidas.push(`Línea ${i + 1}: Sin Lote ("${lote}") o Sin Clave Defecto ("${defectoClave}")`);
        continue;
      }

      validas++;
    }

    totalTxtValidos += validas;
    totalTxtOmitidos += omitidas;
    txtCounts.set(file, { totalLineas: lines.length - 1, validas, omitidas, detalleOmitidas });
  }

  // 3. Imprimir tabla comparativa
  console.log('---------------------------------------------------------------------------------------------------------');
  console.log(
    'ARCHIVO ORIGEN'.padEnd(28) +
    'LÍNEAS TXT'.padStart(12) +
    'VÁLIDAS TXT'.padStart(14) +
    'OMITIDAS TXT'.padStart(14) +
    'REGISTROS CSV'.padStart(15) +
    'ESTADO'.padStart(12)
  );
  console.log('---------------------------------------------------------------------------------------------------------');

  let discrepanciesCount = 0;

  for (const file of TXT_FILES) {
    const stats = txtCounts.get(file);
    const countInCsv = csvByArchivo.get(file) || 0;
    const match = stats ? stats.validas === countInCsv : false;
    if (!match) discrepanciesCount++;

    console.log(
      file.padEnd(28) +
      String(stats ? stats.totalLineas : 0).padStart(12) +
      String(stats ? stats.validas : 0).padStart(14) +
      String(stats ? stats.omitidas : 0).padStart(14) +
      String(countInCsv).padStart(15) +
      (match ? '  ✓ EXACTO' : '  ⚠️ DIFERENCIA')
    );
  }

  console.log('---------------------------------------------------------------------------------------------------------');
  console.log(
    'TOTALES'.padEnd(28) +
    ''.padStart(12) +
    String(totalTxtValidos).padStart(14) +
    String(totalTxtOmitidos).padStart(14) +
    String(csvRows.length).padStart(15) +
    (totalTxtValidos === csvRows.length ? '  ✓ EXACTO' : '  ⚠️ DIFERENCIA')
  );
  console.log('---------------------------------------------------------------------------------------------------------\n');

  // 4. Verificación de archivos no contemplados (ej. Adorno o Df_Ado en CSV)
  console.log('4. Verificación de exclusión de ADORNO y lotes sintéticos:');
  const adornoEnCsv = csvRows.filter(r => 
    r.archivoOrigen.includes('Ado') || 
    r.deptoAuditoria.toUpperCase().includes('ADORNO')
  );
  console.log(`   -> Registros de Adorno encontrados en el CSV: ${adornoEnCsv.length} (esperado: 0)`);

  const lotesSinteticos = csvRows.filter(r => 
    r.lote.startsWith('LOTE-') || 
    r.lote === 'SIN_LOTE' || 
    r.lote === ''
  );
  console.log(`   -> Lotes sintéticos o inventados (LOTE-... / SIN_LOTE / vacío): ${lotesSinteticos.length} (esperado: 0)`);

  // 5. Verificación de la regla de negocio de Líneas (N/A -> L1, etc.)
  console.log('\n5. Verificación de asignación de Línea:');
  const lineasDistintas = new Set(csvRows.map(r => r.linea));
  console.log(`   -> Valores únicos presentes en la columna "Linea": ${Array.from(lineasDistintas).join(', ')}`);

  const lineasSinNormalizar = csvRows.filter(r => !['L1', 'L2', 'ACCESORIO'].includes(r.linea));
  console.log(`   -> Líneas con valor no estándar (distinto de L1, L2 o ACCESORIO para Avíos): ${lineasSinNormalizar.length}`);

  // 6. Resumen de filas omitidas de los TXT (por qué no entraron)
  console.log('\n6. Detalle de las filas omitidas en los TXT:');
  for (const file of TXT_FILES) {
    const stats = txtCounts.get(file);
    if (stats && stats.omitidas > 0) {
      console.log(`   * ${file}: ${stats.omitidas} fila(s) omitida(s):`);
      stats.detalleOmitidas.slice(0, 5).forEach(d => console.log(`       - ${d}`));
      if (stats.detalleOmitidas.length > 5) {
        console.log(`       ... y ${stats.detalleOmitidas.length - 5} más`);
      }
    }
  }

  console.log('\n========================================================================');
  if (discrepanciesCount === 0 && adornoEnCsv.length === 0 && lotesSinteticos.length === 0) {
    console.log('✓ CONCLUSIÓN: AUDITORÍA 100% EXITOSA SIN INCONSISTENCIAS.');
  } else {
    console.log('⚠️ CONCLUSIÓN: Se detectaron discrepancias.');
  }
  console.log('========================================================================\n');
}

runAudit().catch(console.error);

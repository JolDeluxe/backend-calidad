import fs from 'fs';
import path from 'path';
import { prisma } from '../src/config/database';
import { parseCSVLine, extraerModelo } from '../src/modules/lotes/services/lotes-import.service';

// Tipos auxiliares
interface RawRow {
  archivo: string;
  isEliminado: boolean;
  noOriginal: string;
  deptoAuditoriaTexto: string;
  fechaTexto: string;
  fechaParseada: Date;
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
}

interface DirectorioValido {
  tipo: 'local' | 'unc';
  basePath: string;
  workingDir: string;
  tempLocalDir: string | null;
}

function renderProgressBar(current: number, total: number, label: string) {
  const percent = total > 0 ? Math.min(100, Math.floor((current / total) * 100)) : 0;
  const barLength = 30;
  const filled = Math.floor((barLength * percent) / 100);
  const empty = barLength - filled;
  const bar = '='.repeat(filled) + (empty > 0 ? '>' : '') + ' '.repeat(Math.max(0, empty - 1));
  process.stdout.write(`\r[${bar}] ${percent}% (${current.toLocaleString()}/${total.toLocaleString()}) | ${label.padEnd(32)}`);
  if (current >= total) {
    process.stdout.write('\n');
  }
}

function parseFecha(fechaRaw: string): Date {
  const m = fechaRaw.match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
  if (!m) return new Date('2024-01-01T12:00:00Z');
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const y = parseInt(m[3], 10);
  return new Date(Date.UTC(y, mo, d, 12, 0, 0));
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

  // Si tiene formato 'X L1' o 'X L2' como '2L1' => el prefijo suele ser repetición o lote, verificar terminación
  if (/L1/i.test(v) && !/L2/i.test(v)) return 'L1';
  if (/L2/i.test(v) || /LK2/i.test(v) || /LO2/i.test(v) || /LÑ2/i.test(v)) return 'L2';
  if (v === '1' || v === '1L' || v === 'LI') return 'L1';
  if (v === '2' || v === '2L') return 'L2';

  if (/^\d+$/.test(v)) {
    if (v.endsWith('1')) return 'L1';
    if (v.endsWith('2')) return 'L2';
  }

  // Todo lo que no tenga línea explícita o sea dudoso se asigna como L1
  return 'L1';
}

/**
 * Evalúa las rutas candidatas comprobando que contengan archivos .txt reales con tamaño > 0.
 * Si una ruta de red UNC o mapeada devuelve 0 archivos (por ejemplo por aislamiento UAC/elevación),
 * la descarta automáticamente y pasa a la siguiente.
 */
function resolverDirectorioHistorico(archivosRequeridos: string[]): DirectorioValido {
  const candidateDirs = [
    process.env.HISTORICO_DEFECTOS_DIR,
    'H:\\CALIDAD\\App\\Quality System\\DataBase',
    'C:\\Servidor\\Aplicaciones\\Calidad-MBC\\Documentacion\\DtaosBse',
    'C:\\Users\\MBCPROEW10028\\Downloads\\DtaosBse',
    '\\\\200.1.1.58\\usuariosmbc\\CALIDAD\\App\\Quality System\\DataBase',
    '\\\\GC-SRV-ARCHI-01.gc.com\\USUARIOSMBC\\CALIDAD\\App\\Quality System\\DataBase',
  ].filter((p): p is string => Boolean(p));

  for (const dir of candidateDirs) {
    try {
      if (!fs.existsSync(dir)) {
        continue;
      }

      const isUnc = dir.startsWith('\\\\');

      if (isUnc) {
        // En rutas UNC probamos sincronizar con robocopy hacia una carpeta temporal de prueba
        const testTempDir = path.join(process.env.TEMP || 'C:\\Windows\\Temp', `test_calidad_${Date.now()}`);
        fs.mkdirSync(testTempDir, { recursive: true });
        Bun.spawnSync(['robocopy', dir, testTempDir, '*.txt', '/NP', '/NFL', '/NDL']);
        const copied = fs.existsSync(testTempDir) ? fs.readdirSync(testTempDir).filter(f => f.endsWith('.txt')) : [];

        if (copied.length >= 7) {
          console.log(`✓ Directorio UNC accesible y sincronizado: ${dir} (${copied.length} archivos .txt verificados)`);
          return {
            tipo: 'unc',
            basePath: dir,
            workingDir: testTempDir,
            tempLocalDir: testTempDir,
          };
        } else {
          console.warn(`⚠️ Ruta UNC descartada: "${dir}" devolvió ${copied.length} archivos (requiere permisos activos o sesión UAC no elevada)`);
          fs.rmSync(testTempDir, { recursive: true, force: true });
        }
      } else {
        // Rutas locales o unidades mapeadas (ej: H:\ o C:\...)
        const filesFound = archivosRequeridos.filter(file => {
          const fp = path.join(dir, file);
          return fs.existsSync(fp) && fs.statSync(fp).size > 0;
        });

        if (filesFound.length >= 7) {
          console.log(`✓ Directorio válido y accesible: ${dir} (${filesFound.length} de ${archivosRequeridos.length} archivos verificados)`);
          return {
            tipo: 'local',
            basePath: dir,
            workingDir: dir,
            tempLocalDir: null,
          };
        } else {
          console.warn(`⚠️ Ruta descartada: "${dir}" contiene solo ${filesFound.length} archivos requeridos con tamaño > 0`);
        }
      }
    } catch (err: any) {
      console.warn(`⚠️ Ruta descartada por excepción: "${dir}" (${err.message})`);
    }
  }

  throw new Error(
    `[ERROR CRÍTICO]: No se encontró ningún directorio con los archivos .txt requeridos (>0 bytes) en las rutas:\n${candidateDirs.map(p => ` - ${p}`).join('\n')}\nABORTANDO SIN MODIFICAR LA BASE DE DATOS.`
  );
}

async function main() {
  console.log('========================================================================');
  console.log('INICIANDO IMPORTACIÓN DE HISTÓRICO DE DEFECTOS Y AUDITORÍAS (CALIDAD MBC)');
  console.log('========================================================================\n');

  console.log('Entorno actual (NODE_ENV):', process.env.NODE_ENV || 'development');

  const files = [
    // Archivos de defectos activos por departamento (7 archivos de producción)
    // Se omiten Df_Ado.txt y Defectos_Adorno.txt para excluir totalmente datos de ADORNO y evitar lotes sintéticos/inventados
    'Defectos_Acabado.txt',
    'Defectos_Avios.txt',
    'Defectos_Bordado.txt',
    'Defectos_corte.txt',
    'Defectos_Montado.txt',
    'Defectos_Pespunte.txt',
    'Defectos_Preliminares.txt',
  ];

  // Resolver directorio comprobando existencia real de archivos y tamaño > 0
  const dirInfo = resolverDirectorioHistorico(files);
  const basePath = dirInfo.basePath;
  const workingDir = dirInfo.workingDir;
  const tempLocalDir = dirInfo.tempLocalDir;

  console.log('Directorio origen seleccionado:', basePath);
  console.log('Directorio de trabajo:', workingDir);

  try {
    // 1. Cargar referencias base en memoria
    console.log('\n1. Cargando catálogos de referencia en memoria...');
    const departamentosDB = await prisma.departamento.findMany();
    const usuariosDB = await prisma.usuario.findMany();
    let defectosDB = await prisma.defecto.findMany();

    // Asegurar que exista un defecto comodín histórico para claves que ya no existen o filas incompletas
    let defectoHistoricoDesconocido = defectosDB.find(d => d.clave === 9999);
    if (!defectoHistoricoDesconocido) {
      console.log('  -> Creando defecto comodín clave 9999 para registros históricos huérfanos...');
      const deptoCorte = departamentosDB.find(d => d.codigo === 'CORTE') || departamentosDB[0];
      defectoHistoricoDesconocido = await prisma.defecto.create({
        data: {
          clave: 9999,
          defecto: 'Defecto histórico no catalogado / eliminado de catálogo',
          clasificacion: 'MENOR',
          departamentoId: deptoCorte.id,
          activo: false,
          creadoPor: 1,
        }
      });
      defectosDB.push(defectoHistoricoDesconocido);
    }

    // Mapeos de Departamentos
    const deptoMap = new Map<string, number>();
    for (const dep of departamentosDB) {
      deptoMap.set(normalizarTexto(dep.codigo), dep.id);
      deptoMap.set(normalizarTexto(dep.nombre), dep.id);
    }
    // Variaciones conocidas
    deptoMap.set('PESPUNTE', deptoMap.get('PESPUNTE') || deptoMap.get('PESPUENTE') || 4);
    deptoMap.set('PESPUENTE', deptoMap.get('PESPUNTE') || 4);
    deptoMap.set('BORDADO', deptoMap.get('BORDADO Y LASER') || deptoMap.get('BORDADO_Y_LASER') || 3);
    deptoMap.set('BORDADO Y LASER', deptoMap.get('BORDADO_Y_LASER') || deptoMap.get('BORDADO Y LASER') || 3);
    deptoMap.set('ADORNO', deptoMap.get('ADORNO') || 11);
    deptoMap.set('PRUEBA', deptoMap.get('CORTE') || 1);

    // Mapeo inequívoco del archivo origen a la terminal/departamento de auditoría
    const archivoAuditoriaMap = new Map<string, number>([
      ['Defectos_corte.txt', deptoMap.get('CORTE') || 1],
      ['Defectos_Preliminares.txt', deptoMap.get('PRELIMINARES') || 2],
      ['Defectos_Bordado.txt', deptoMap.get('BORDADO_Y_LASER') || deptoMap.get('BORDADO Y LASER') || 3],
      ['Defectos_Pespunte.txt', deptoMap.get('PESPUNTE') || 4],
      ['Defectos_Montado.txt', deptoMap.get('MONTADO') || 5],
      ['Defectos_Acabado.txt', deptoMap.get('ACABADO') || 6],
      ['Defectos_Avios.txt', deptoMap.get('AVIOS') || 7],
      ['Defectos_Adorno.txt', deptoMap.get('ADORNO') || 11],
      ['Df_Ado.txt', deptoMap.get('ADORNO') || 11],
    ]);

    const defaultDeptoId = deptoMap.get('CORTE') || departamentosDB[0].id;

    // Mapeos de Usuarios
    const userMap = new Map<string, number>();
    for (const u of usuariosDB) {
      userMap.set(normalizarTexto(u.nombre), u.id);
      userMap.set(normalizarTexto(u.usuario), u.id);
    }
    // Variaciones ortográficas o truncadas de nombres en legacy
    const superAdminId = usuariosDB.find(u => u.usuario === 'super.admin' || u.usuario === 'admin')?.id || 1;
    const albaId = userMap.get('ALBA MARISOL MUNOZ') || superAdminId;
    const vanessaId = userMap.get('VANESSA JACQUELIN VALLECILLO') || superAdminId;
    const yolandaId = userMap.get('YOLANDA FLORES') || superAdminId;
    const ulisesId = userMap.get('ULISES ISRAEL MORENO GALLEGOS') || userMap.get('ULISES.MORENO') || superAdminId;

    userMap.set('ALBA MARISOL MUNOZ', albaId);
    userMap.set('ALBA MARISOL MU OZ', albaId);
    userMap.set('ALBA MARISOL MU', albaId);
    userMap.set('ALBA MARISOL MU?OZ', albaId);
    userMap.set('ALBA MARISOL MUï¿½OZ', albaId);
    userMap.set('VANESSA JACQUELIN VALLECIL', vanessaId);
    userMap.set('YOLANDA FLOR', yolandaId);
    userMap.set('ULISES MORENO', ulisesId);
    userMap.set('ULISES ISRAEL MORENO GALLEGOS', ulisesId);
    // Inspector de Df_Ado.txt (se asigna a Wendy Lizbeth Sánchez como inspectora de Adorno o al inspector encontrado)
    const adornoInspectorId = userMap.get('WENDY LIZBETH SANCHEZ') || superAdminId;
    userMap.set('FERNANDO MENDOZA', adornoInspectorId);

    // Mapeos de Defectos por clave y por nombre normalizado
    const defectoClaveMap = new Map<number, { id: number; departamentoId: number }>();
    const defectoNombreMap = new Map<string, { id: number; departamentoId: number; clave: number }>();
    for (const d of defectosDB) {
      defectoClaveMap.set(d.clave, { id: d.id, departamentoId: d.departamentoId });
      defectoNombreMap.set(normalizarTexto(d.defecto), { id: d.id, departamentoId: d.departamentoId, clave: d.clave });
    }

    // 2. Parsear los 8 archivos activos de defectos ANTES de tocar la base de datos
    console.log(`\n2. Leyendo y analizando los ${files.length} archivos planos...`);
    const allRows: RawRow[] = [];
    let skippedRows = 0;

    for (const file of files) {
      const filePath = path.join(workingDir, file);
      if (!fs.existsSync(filePath)) {
        console.warn(`  [ADVERTENCIA] Archivo no encontrado: ${filePath}`);
        continue;
      }

      const content = fs.readFileSync(filePath, 'latin1');
      const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
      const isEliminado = file.startsWith('Eliminados_');
      const isAviosDefectos = (file === 'Defectos_Avios.txt');
      const isDfAdo = (file === 'Df_Ado.txt');

      for (let i = 0; i < lines.length; i++) {
        const parts = lines[i].split('\t').map(p => p.trim());
        if (parts[0] === 'No') continue; // Fila de cabecera

        let noOriginal = parts[0] || '';
        let deptoAuditoriaTexto = parts[1] || '';
        let fechaTexto = parts[2] || '';
        let lista = parts[3] || 'N/A';
        let lote = parts[4] || '';
        let lineaTexto = '';
        let modelo = '';
        let descripcion = '';
        let defDeptoTexto = '';
        let defectoClave = 0;
        let defectoNombre = '';
        let pares = 1;
        let horma = '';
        let usuarioTexto = '';

        // Omitir totalmente cualquier registro de ADORNO (sea archivo de Adorno o departamento de Adorno)
        const deptoAuditNorm = normalizarTexto(parts[1] || '');
        if (isDfAdo || file === 'Defectos_Adorno.txt' || deptoAuditNorm === 'ADORNO') {
          skippedRows++;
          continue;
        }

        if (isAviosDefectos) {
          // En Defectos_Avios.txt la columna Linea fue omitida o desplazada
          lineaTexto = 'ACCESORIO';
          modelo = parts[5] || '';
          descripcion = parts[6] || '';
          defDeptoTexto = parts[7] || 'AVIOS';
          defectoClave = parseInt(parts[8], 10) || 0;
          defectoNombre = parts[9] || '';
          pares = parseInt(parts[10], 10) || 1;
          horma = parts[11] || '';
          usuarioTexto = parts[12] || '';
        } else {
          lineaTexto = parts[5] || '';
          modelo = parts[6] || '';
          descripcion = parts[7] || '';
          defDeptoTexto = parts[8] || '';
          defectoClave = parseInt(parts[9], 10) || 0;
          defectoNombre = parts[10] || '';
          pares = parseInt(parts[11], 10) || 1;
          horma = parts[12] || '';
          usuarioTexto = parts[13] || '';
        }

        // Normalizar lineaTexto para evitar textos corrompidos de Access (ej: '6L2', 'LK2', '17561')
        lineaTexto = normalizarLineaTexto(lineaTexto);

        // Validar fila mínima: si no viene lote o clave de defecto, se ignora
        if (!lote || !defectoClave) {
          skippedRows++;
          continue;
        }

        const fechaParseada = parseFecha(fechaTexto);

        allRows.push({
          archivo: file,
          isEliminado,
          noOriginal,
          deptoAuditoriaTexto,
          fechaTexto,
          fechaParseada,
          lista,
          lote,
          lineaTexto,
          modelo,
          descripcion,
          defDeptoTexto,
          defectoClave,
          defectoNombre,
          pares: isNaN(pares) || pares <= 0 ? 1 : pares,
          horma,
          usuarioTexto,
        });
      }
    }

    console.log(`  -> Total filas válidas extraídas: ${allRows.length.toLocaleString()}`);
    if (skippedRows > 0) {
      console.log(`  -> Filas vacías ignoradas: ${skippedRows}`);
    }

    // VALIDACIÓN CRÍTICA: NUNCA BORRAR LA BD SI NO SE EXTRAJERON FILAS
    if (allRows.length === 0) {
      throw new Error(
        `[ABORTO DE SEGURIDAD]: Se extrajeron 0 filas válidas de los archivos en "${basePath}".\nLA BASE DE DATOS NO HA SIDO MODIFICADA.`
      );
    }

    // 3. LIMPIEZA SEGURA DE TABLAS PREVIAS (SOLO TRAS COMPROBAR QUE HAY DATOS A REEMPLAZAR)
    console.log('\n3. Procediendo al reemplazo limpio de tablas históricas...');
    await prisma.inspeccionDetalle.deleteMany();
    await prisma.inspeccionCabecera.deleteMany();
    await prisma.produccionLote.deleteMany();
    await prisma.inspeccionHistoricaOrigen.deleteMany();
    console.log('✓ Tablas anteriores limpiadas exitosamente.');

    // 4. Poblar InspeccionHistoricaOrigen en lotes de 1,000 registros
    console.log('\n4. Insertando registros en tabla inspecciones_historicas_origen...');
    const BATCH_SIZE = 1000;
    for (let i = 0; i < allRows.length; i += BATCH_SIZE) {
      const chunk = allRows.slice(i, i + BATCH_SIZE);
      await prisma.inspeccionHistoricaOrigen.createMany({
        data: chunk.map(r => ({
          noOriginal: r.noOriginal || null,
          departamento: r.deptoAuditoriaTexto || null,
          fechaTexto: r.fechaTexto || null,
          fechaParseada: r.fechaParseada,
          lista: r.lista || null,
          lote: r.lote || null,
          linea: r.lineaTexto || null,
          modelo: r.modelo || null,
          descripcion: r.descripcion || null,
          defDepto: r.defDeptoTexto || null,
          defectoClave: r.defectoClave || null,
          defectoNombre: r.defectoNombre || null,
          pares: r.pares,
          horma: r.horma || null,
          usuarioTexto: r.usuarioTexto || null,
          archivoOrigen: r.archivo,
        })),
        skipDuplicates: true,
      });
      renderProgressBar(Math.min(i + BATCH_SIZE, allRows.length), allRows.length, 'inspecciones_historicas_origen');
    }

    // 5. Cargar archivo maestro de lotes CSV (si existe) para poblar pares reales (Cantidad) y datos base
    console.log('\n5. Consolidando y registrando lotes de producción con datos reales...');
    const lotesCsvData = new Map<string, { listaLote: string; lista: string; lote: string; idProducto: string; modelo: string; cantidad: number; descripcion: string; cliente: string; horma: string }>();

    const candidateCsvPaths = [
      process.env.LOTES_CSV_PATH,
      'C:\\Servidor\\Aplicaciones\\Calidad-MBC\\Documentacion\\DtaosBse\\Calidad Datos Base.csv',
      'C:\\Users\\MBCPROEW10028\\Downloads\\DtaosBse\\Calidad Datos Base.csv',
      'H:\\CALIDAD\\App\\Quality System\\DataBase\\Calidad Datos Base.csv',
      '\\\\200.1.1.58\\usuariosmbc\\CALIDAD\\App\\Quality System\\DataBase\\Calidad Datos Base.csv',
      '\\\\GC-SRV-ARCHI-01.gc.com\\USUARIOSMBC\\CALIDAD\\App\\Quality System\\DataBase\\Calidad Datos Base.csv',
    ].filter((p): p is string => Boolean(p));

    let csvPathEncontrado: string | null = null;
    for (const p of candidateCsvPaths) {
      if (fs.existsSync(p) && fs.statSync(p).size > 0) {
        csvPathEncontrado = p;
        break;
      }
    }

    if (csvPathEncontrado) {
      console.log(`  -> Archivo maestro de lotes encontrado en: ${csvPathEncontrado}`);
      const csvContent = fs.readFileSync(csvPathEncontrado, 'utf-8');
      const csvLines = csvContent.trim().split(/\r?\n/);
      for (let i = 1; i < csvLines.length; i++) {
        const cols = parseCSVLine(csvLines[i]).map(c => c.trim());
        const listaLote = cols[0] || '';
        const lista = cols[1] || '';
        const lote = cols[2] || '';
        const idProducto = cols[3] || '';
        const cantidad = parseFloat(cols[4]) || 0;
        const descripcion = cols[5] || '';
        const cliente = cols[6] || 'CUADRA PRODUCCIÓN';
        const horma = cols[7] || '';

        if (!lote) continue;
        const modeloExt = extraerModelo(idProducto).modelo || (idProducto.length >= 6 ? idProducto.substring(0, 6) : idProducto);

        lotesCsvData.set(lote, {
          listaLote,
          lista,
          lote,
          idProducto,
          modelo: modeloExt || 'N/A',
          cantidad,
          descripcion,
          cliente,
          horma,
        });
      }
      console.log(`  -> Lotes maestros leídos con pares (cantidad): ${lotesCsvData.size.toLocaleString()}`);
    }

    // Unir lotes de archivos históricos con el maestro CSV
    const lotesMap = new Map<string, { listaLote: string; lista: string; idProducto: string; modelo: string; cantidad: number; descripcion: string; cliente: string; horma: string }>();

    // Primero los del CSV con sus pares reales
    for (const [lote, data] of lotesCsvData.entries()) {
      lotesMap.set(lote, data);
    }

    // Luego los del histórico TXT (si no estaban en CSV, se agregan con los datos de Access)
    for (const r of allRows) {
      if (r.lote && !lotesMap.has(r.lote)) {
        lotesMap.set(r.lote, {
          listaLote: `${r.lista}-${r.lote}`,
          lista: r.lista || 'N/A',
          idProducto: r.modelo || 'N/A',
          modelo: r.modelo || 'N/A',
          cantidad: 0,
          descripcion: r.descripcion || '',
          cliente: 'CUADRA PRODUCCIÓN',
          horma: r.horma || '',
        });
      }
    }

    const existingLotes = await prisma.produccionLote.findMany({ select: { id: true, lote: true } });
    const loteIdMap = new Map<string, number>(existingLotes.map(l => [l.lote, l.id]));

    const newLotes = Array.from(lotesMap.entries()).filter(([lote]) => !loteIdMap.has(lote));
    console.log(`  -> Total lotes a registrar: ${newLotes.length.toLocaleString()}`);

    const LOTE_BATCH = 500;
    for (let i = 0; i < newLotes.length; i += LOTE_BATCH) {
      const chunk = newLotes.slice(i, i + LOTE_BATCH);
      await prisma.produccionLote.createMany({
        data: chunk.map(([lote, data]) => ({
          lote,
          listaLote: data.listaLote ? data.listaLote.substring(0, 100) : `${data.lista}-${lote}`,
          lista: data.lista ? data.lista.substring(0, 50) : 'N/A',
          idProducto: data.idProducto ? data.idProducto.substring(0, 100) : data.modelo,
          modelo: data.modelo ? data.modelo.substring(0, 50) : 'N/A',
          descripcion: data.descripcion ? data.descripcion.substring(0, 255) : '',
          cliente: data.cliente ? data.cliente.substring(0, 200) : 'CUADRA PRODUCCIÓN',
          cantidad: data.cantidad,
          horma: data.horma ? data.horma.substring(0, 60) : '',
          creadoPor: superAdminId,
        })),
        skipDuplicates: true,
      });
      renderProgressBar(Math.min(i + LOTE_BATCH, newLotes.length), newLotes.length, 'produccion_lotes');
    }

    // Refrescar mapa de lotes
    const allLotesDB = await prisma.produccionLote.findMany({ select: { id: true, lote: true } });
    for (const l of allLotesDB) {
      loteIdMap.set(l.lote, l.id);
    }

    // 6. Agrupar filas en sesiones de Inspección (InspeccionCabecera)
    console.log('\n6. Agrupando e insertando sesiones de inspección (cabeceras)...');
    interface CabeceraGroup {
      loteId: number;
      inspectorId: number;
      departamentoAuditoriaId: number;
      lineaTexto: string;
      horma: string;
      fechaInspeccion: Date;
      isEliminado: boolean;
      detalles: RawRow[];
    }

    const cabecerasMap = new Map<string, CabeceraGroup>();

    for (const r of allRows) {
      const loteId = loteIdMap.get(r.lote);
      if (!loteId) continue;

      // Determinar la terminal / departamento de auditoría según el archivo de origen (cada archivo representa su estación física)
      const normAuditoria = normalizarTexto(r.deptoAuditoriaTexto);
      const departamentoAuditoriaId = archivoAuditoriaMap.get(r.archivo) || deptoMap.get(normAuditoria) || defaultDeptoId;

      // Normalizar inspector
      const normUser = normalizarTexto(r.usuarioTexto);
      let inspectorId = userMap.get(normUser);
      
      // Si la fila histórica venía sin inspector (5 casos huérfanos), asignar el inspector oficial del departamento auditado
      if (!inspectorId) {
        if (normAuditoria.includes('PESPUNTE')) {
          inspectorId = userMap.get('FRANCISCO ARTURO GONZALEZ') || superAdminId;
        } else if (normAuditoria.includes('ACABADO')) {
          inspectorId = userMap.get('ALEJANDRO GUEVARA') || superAdminId;
        } else if (normAuditoria.includes('MONTADO')) {
          inspectorId = userMap.get('KEVIN ROBERTO CANCINO') || superAdminId;
        } else {
          inspectorId = superAdminId;
        }
      }

      // Clave de sesión
      const dateStr = r.fechaParseada.toISOString().split('T')[0];
      const sessionKey = `${loteId}|${inspectorId}|${departamentoAuditoriaId}|${dateStr}|${r.isEliminado ? '1' : '0'}`;

      if (!cabecerasMap.has(sessionKey)) {
        cabecerasMap.set(sessionKey, {
          loteId,
          inspectorId,
          departamentoAuditoriaId,
          lineaTexto: r.lineaTexto,
          horma: r.horma,
          fechaInspeccion: r.fechaParseada,
          isEliminado: r.isEliminado,
          detalles: [],
        });
      }

      cabecerasMap.get(sessionKey)!.detalles.push(r);
    }

    const cabeceraList = Array.from(cabecerasMap.values());
    console.log(`  -> Total sesiones de inspección únicas a crear: ${cabeceraList.length.toLocaleString()}`);

    // Insertar cabeceras en lotes
    const CABECERA_BATCH = 500;
    let folioConsecutivo = 1;

    for (let i = 0; i < cabeceraList.length; i += CABECERA_BATCH) {
      const chunk = cabeceraList.slice(i, i + CABECERA_BATCH);
      const chunkData = chunk.map(c => {
        const folio = `HIST-${c.fechaInspeccion.getUTCFullYear()}-${folioConsecutivo.toString().padStart(7, '0')}`;
        folioConsecutivo++;
        return {
          folio,
          loteId: c.loteId,
          inspectorId: c.inspectorId,
          departamentoAuditoriaId: c.departamentoAuditoriaId,
          lineaTexto: c.lineaTexto ? c.lineaTexto.substring(0, 30) : null,
          horma: c.horma ? c.horma.substring(0, 60) : null,
          fechaInspeccion: c.fechaInspeccion,
          estado: 'RECHAZADO' as const,
          notas: c.isEliminado ? 'Sesión histórica importada (con defectos eliminados)' : 'Sesión histórica importada de Access',
          creadoPor: superAdminId,
          eliminadoEn: c.isEliminado ? c.fechaInspeccion : null,
          eliminadoPor: c.isEliminado ? c.inspectorId : null,
        };
      });

      await prisma.inspeccionCabecera.createMany({
        data: chunkData,
        skipDuplicates: true,
      });

      renderProgressBar(Math.min(i + CABECERA_BATCH, cabeceraList.length), cabeceraList.length, 'inspecciones_cabecera');
    }

    // 7. Obtener IDs de las cabeceras creadas para vincular detalles
    console.log('\n7. Recuperando cabeceras registradas para vinculación de detalles...');
    const allCabecerasDB = await prisma.inspeccionCabecera.findMany({
      select: {
        id: true,
        loteId: true,
        inspectorId: true,
        departamentoAuditoriaId: true,
        fechaInspeccion: true,
        eliminadoEn: true,
      }
    });

    const dbCabeceraKeyMap = new Map<string, number>();
    for (const c of allCabecerasDB) {
      const dateStr = c.fechaInspeccion.toISOString().split('T')[0];
      const key = `${c.loteId}|${c.inspectorId}|${c.departamentoAuditoriaId}|${dateStr}|${c.eliminadoEn ? '1' : '0'}`;
      dbCabeceraKeyMap.set(key, c.id);
    }

    // 8. Preparar e insertar los detalles de inspección
    console.log('8. Preparando e insertando detalles de defectos (inspecciones_detalle)...');
    interface DetalleToInsert {
      inspeccionId: number;
      defectoId: number;
      defDeptoId: number;
      paresDefectuosos: number;
      notas: string | null;
      creadoPor: number;
      fechaCreacion: Date;
      eliminadoEn: Date | null;
      eliminadoPor: number | null;
      eliminadoMotivo: string | null;
    }

    const detallesToInsert: DetalleToInsert[] = [];

    for (const r of allRows) {
      const loteId = loteIdMap.get(r.lote);
      if (!loteId) continue;

      const normUser = normalizarTexto(r.usuarioTexto);
      let inspectorId = userMap.get(normUser);
      const normAuditoria = normalizarTexto(r.deptoAuditoriaTexto);
      if (!inspectorId) {
        if (normAuditoria.includes('PESPUNTE')) {
          inspectorId = userMap.get('FRANCISCO ARTURO GONZALEZ') || superAdminId;
        } else if (normAuditoria.includes('ACABADO')) {
          inspectorId = userMap.get('ALEJANDRO GUEVARA') || superAdminId;
        } else if (normAuditoria.includes('MONTADO')) {
          inspectorId = userMap.get('KEVIN ROBERTO CANCINO') || superAdminId;
        } else {
          inspectorId = superAdminId;
        }
      }

      const departamentoAuditoriaId = archivoAuditoriaMap.get(r.archivo) || deptoMap.get(normAuditoria) || defaultDeptoId;

      const dateStr = r.fechaParseada.toISOString().split('T')[0];
      const sessionKey = `${loteId}|${inspectorId}|${departamentoAuditoriaId}|${dateStr}|${r.isEliminado ? '1' : '0'}`;
      const inspeccionId = dbCabeceraKeyMap.get(sessionKey);
      if (!inspeccionId) continue;

      // Resolver defectoId
      let defInfo = defectoClaveMap.get(r.defectoClave);
      if (!defInfo) {
        defInfo = { id: defectoHistoricoDesconocido.id, departamentoId: defaultDeptoId };
      }

      // Resolver departamento responsable (defDepto)
      const normDefDepto = normalizarTexto(r.defDeptoTexto);
      const defDeptoId = deptoMap.get(normDefDepto) || defInfo.departamentoId || defaultDeptoId;

      detallesToInsert.push({
        inspeccionId,
        defectoId: defInfo.id,
        defDeptoId,
        paresDefectuosos: r.pares,
        notas: r.defectoNombre ? r.defectoNombre.substring(0, 255) : null,
        creadoPor: inspectorId,
        fechaCreacion: r.fechaParseada,
        eliminadoEn: r.isEliminado ? r.fechaParseada : null,
        eliminadoPor: r.isEliminado ? inspectorId : null,
        eliminadoMotivo: r.isEliminado ? 'Registro histórico de archivo Eliminados' : null,
      });
    }

    console.log(`  -> Total detalles de defectos preparados: ${detallesToInsert.length.toLocaleString()}`);

    const DETALLE_BATCH = 1000;
    for (let i = 0; i < detallesToInsert.length; i += DETALLE_BATCH) {
      const chunk = detallesToInsert.slice(i, i + DETALLE_BATCH);
      await prisma.inspeccionDetalle.createMany({
        data: chunk,
        skipDuplicates: true,
      });
      renderProgressBar(Math.min(i + DETALLE_BATCH, detallesToInsert.length), detallesToInsert.length, 'inspecciones_detalle');
    }

    // 9. Resumen y verificación final
    console.log('\n========================================================================');
    console.log('VERIFICACIÓN FINAL DE IMPORTACIÓN');
    console.log('========================================================================');
    const totalHistoricas = await prisma.inspeccionHistoricaOrigen.count();
    const totalLotes = await prisma.produccionLote.count();
    const totalCabeceras = await prisma.inspeccionCabecera.count();
    const totalDetalles = await prisma.inspeccionDetalle.count();

    console.log(`✓ Registros históricos originales: ${totalHistoricas.toLocaleString()}`);
    console.log(`✓ Lotes de producción:             ${totalLotes.toLocaleString()}`);
    console.log(`✓ Sesiones de inspección:          ${totalCabeceras.toLocaleString()}`);
    console.log(`✓ Detalles de defectos:            ${totalDetalles.toLocaleString()}`);
    console.log('========================================================================\n');
    console.log('¡Importación completada con éxito!');
  } finally {
    if (tempLocalDir && fs.existsSync(tempLocalDir)) {
      try {
        fs.rmSync(tempLocalDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
}

main()
  .catch(err => {
    console.error('\n[ERROR FATAL EN IMPORTACIÓN]:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

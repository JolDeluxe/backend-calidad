import fs from 'fs';
import path from 'path';
import { prisma } from '../src/config/database';

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

async function main() {
  console.log('========================================================================');
  console.log('INICIANDO IMPORTACIÓN DE HISTÓRICO DE DEFECTOS Y AUDITORÍAS (CALIDAD MBC)');
  console.log('========================================================================\n');

  const candidateDirs = [
    process.env.HISTORICO_DEFECTOS_DIR,
    'C:\\Servidor\\Aplicaciones\\Calidad-MBC\\Documentacion\\DtaosBse',
    'C:\\Users\\MBCPROEW10028\\Downloads\\DtaosBse',
    'H:\\CALIDAD\\App\\Quality System\\DataBase',
  ].filter((p): p is string => Boolean(p));

  const basePath = candidateDirs.find(p => fs.existsSync(p));

  console.log('Entorno actual (NODE_ENV):', process.env.NODE_ENV || 'development');
  console.log('Directorio de datos seleccionado:', basePath || 'NINGUNO ENCONTRADO');

  if (!basePath || !fs.existsSync(basePath)) {
    throw new Error(
      `No se encontró el directorio de datos históricos en ninguna de las rutas esperadas:\n${candidateDirs.map(p => ` - ${p}`).join('\n')}`
    );
  }

  const files = [
    // Archivos de defectos activos
    'Defectos_corte.txt',
    'Defectos_Preliminares.txt',
    'Defectos_Bordado.txt',
    'Defectos_Pespunte.txt',
    'Defectos_Montado.txt',
    'Defectos_Acabado.txt',
    'Defectos_Adorno.txt',
    'Defectos_Avios.txt',
    // Archivos de eliminados
    'Eliminados_Corte.txt',
    'Eliminados_Preliminares.txt',
    'Eliminados_Bordado.txt',
    'Eliminados_Pespunte.txt',
    'Eliminados_Montado.txt',
    'Eliminados_Acabado.txt',
    'Eliminados_Adorno.txt',
    'Eliminados_Avios.txt',
  ];

  // 1. Cargar referencias base en memoria
  console.log('1. Cargando catálogos de referencia en memoria...');
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
  deptoMap.set('BORDADO', deptoMap.get('BORDADO Y LASER') || 3);
  deptoMap.set('BORDADO Y LASER', deptoMap.get('BORDADO_Y_LASER') || deptoMap.get('BORDADO Y LASER') || 3);
  deptoMap.set('ADORNO', deptoMap.get('PESPUNTE') || 4); // Adorno pertenece al área de Pespunte en el flujo
  deptoMap.set('PRUEBA', deptoMap.get('CORTE') || 1);

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

  // Mapeos de Defectos por clave
  const defectoClaveMap = new Map<number, { id: number; departamentoId: number }>();
  for (const d of defectosDB) {
    defectoClaveMap.set(d.clave, { id: d.id, departamentoId: d.departamentoId });
  }

  // 2. Parsear los 16 archivos
  console.log('2. Leyendo y analizando los 16 archivos planos...');
  const allRows: RawRow[] = [];
  let skippedRows = 0;

  for (const file of files) {
    const filePath = path.join(basePath, file);
    if (!fs.existsSync(filePath)) {
      console.warn(`  [ADVERTENCIA] Archivo no encontrado: ${filePath}`);
      continue;
    }

    const content = fs.readFileSync(filePath, 'latin1');
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    const isEliminado = file.startsWith('Eliminados_');
    const isAviosDefectos = (file === 'Defectos_Avios.txt');

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

      if (isAviosDefectos) {
        // En Defectos_Avios.txt la columna Linea fue omitida o desplazada
        // parts[5]=Modelo, parts[6]=Descripcion, parts[7]=DefDepto, parts[8]=Clave, parts[9]=Defecto, parts[10]=Prs, parts[11]=Horma, parts[12]=Usuario
        lineaTexto = 'ACCESORIO';
        modelo = parts[5] || 'N/A';
        descripcion = parts[6] || '';
        defDeptoTexto = parts[7] || 'AVIOS';
        defectoClave = parseInt(parts[8], 10) || 0;
        defectoNombre = parts[9] || '';
        pares = parseInt(parts[10], 10) || 1;
        horma = parts[11] || '';
        usuarioTexto = parts[12] || '';
      } else {
        lineaTexto = parts[5] || 'N/A';
        modelo = parts[6] || 'N/A';
        descripcion = parts[7] || '';
        defDeptoTexto = parts[8] || '';
        defectoClave = parseInt(parts[9], 10) || 0;
        defectoNombre = parts[10] || '';
        pares = parseInt(parts[11], 10) || 1;
        horma = parts[12] || '';
        usuarioTexto = parts[13] || '';
      }

      // Validar fila mínima
      if (!lote && !defectoClave) {
        skippedRows++;
        continue;
      }

      // Si la clave no vino o es 0, usar el comodín histórico
      if (!defectoClave) {
        defectoClave = 9999;
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
        lote: lote || 'SIN_LOTE',
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

  // 3. Poblar InspeccionHistoricaOrigen en lotes de 1,000 registros
  console.log('\n3. Insertando registros en tabla inspecciones_historicas_origen...');
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

  // 4. Crear Lotes de producción (ProduccionLote) únicos
  console.log('\n4. Consolidando y registrando lotes únicos de producción...');
  const lotesMap = new Map<string, { lista: string; modelo: string; descripcion: string; horma: string }>();
  for (const r of allRows) {
    if (r.lote && !lotesMap.has(r.lote)) {
      lotesMap.set(r.lote, {
        lista: r.lista || 'N/A',
        modelo: r.modelo || 'N/A',
        descripcion: r.descripcion || '',
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
        listaLote: `${data.lista}-${lote}`,
        lista: data.lista,
        idProducto: data.modelo,
        modelo: data.modelo,
        descripcion: data.descripcion ? data.descripcion.substring(0, 255) : '',
        cliente: 'CUADRA PRODUCCIÓN',
        cantidad: 0,
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

  // 5. Agrupar filas en sesiones de Inspección (InspeccionCabecera)
  console.log('\n5. Agrupando e insertando sesiones de inspección (cabeceras)...');
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

    // Normalizar departamento auditoría
    const normAuditoria = normalizarTexto(r.deptoAuditoriaTexto);
    const departamentoAuditoriaId = deptoMap.get(normAuditoria) || defaultDeptoId;

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
  const cabeceraIdList: { id: number; detalles: RawRow[]; isEliminado: boolean; fecha: Date }[] = [];

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
        eliminadoPor: c.isEliminado ? superAdminId : null,
      };
    });

    await prisma.inspeccionCabecera.createMany({
      data: chunkData,
      skipDuplicates: true,
    });

    renderProgressBar(Math.min(i + CABECERA_BATCH, cabeceraList.length), cabeceraList.length, 'inspecciones_cabecera');
  }

  // 6. Obtener IDs de las cabeceras creadas para vincular detalles
  console.log('\n6. Recuperando cabeceras registradas para vinculación de detalles...');
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

  // 7. Preparar e insertar los detalles de inspección
  console.log('7. Preparando e insertando detalles de defectos (inspecciones_detalle)...');
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

    const departamentoAuditoriaId = deptoMap.get(normAuditoria) || defaultDeptoId;

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

  // 8. Resumen y verificación final
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
}

main()
  .catch(err => {
    console.error('\n[ERROR FATAL EN IMPORTACIÓN]:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

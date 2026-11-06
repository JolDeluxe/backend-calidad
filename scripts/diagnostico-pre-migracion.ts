import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { prisma } from '../src/config/database';
import { legacyIncrementalSyncService } from '../src/modules/inspecciones/services/legacy-incremental-sync.service';

async function main() {
  console.log('========================================================================');
  console.log('DIAGNÓSTICO PRE-MIGRACIÓN Y RESPALDO VERIFICABLE (CALIDAD MBC)');
  console.log('========================================================================\n');

  const backupsDir = path.join(process.cwd(), 'backups');
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  // 1. Crear respaldo verificable de los registros existentes en la BD actual
  console.log('1. GENERANDO RESPALDO DE SEGURIDAD PRE-MIGRACIÓN...');
  const cabecerasExistentes = await prisma.inspeccionCabecera.findMany({
    include: {
      detalles: true,
    },
  });

  const timestamp = Date.now();
  const backupFilename = `backup_pre_migracion_${timestamp}.json`;
  const backupPath = path.join(backupsDir, backupFilename);

  const backupPayload = {
    generadoEn: new Date().toISOString(),
    entorno: process.env.NODE_ENV || 'production',
    totalCabeceras: cabecerasExistentes.length,
    totalDetalles: cabecerasExistentes.reduce((acc, c) => acc + c.detalles.length, 0),
    cabeceras: cabecerasExistentes,
  };

  const rawBackup = JSON.stringify(backupPayload, null, 2);
  fs.writeFileSync(backupPath, rawBackup, 'utf8');
  const backupHash = crypto.createHash('sha256').update(rawBackup).digest('hex');

  // Validar inmediatamente que el archivo guardado sea íntegro y restaurable en memoria
  const parsedBackup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const isRestorable =
    parsedBackup &&
    typeof parsedBackup === 'object' &&
    Array.isArray(parsedBackup.cabeceras) &&
    parsedBackup.cabeceras.length === cabecerasExistentes.length;

  console.log(`   - Archivo generado:       ${backupPath}`);
  console.log(`   - Tamaño (bytes):         ${rawBackup.length.toLocaleString()}`);
  console.log(`   - SHA-256:                ${backupHash}`);
  console.log(`   - Total cabeceras:        ${cabecerasExistentes.length.toLocaleString()}`);
  console.log(`   - Total detalles:         ${backupPayload.totalDetalles.toLocaleString()}`);
  console.log(`   - Integridad del backup:  ${isRestorable ? '✓ VÁLIDO Y RESTAURABLE' : '✗ FALLO'}\n`);

  if (!isRestorable) {
    throw new Error('El respaldo generado no pasó la validación de integridad.');
  }

  // 2. Diagnóstico de los registros en inspecciones_historicas_origen
  const totalHistorico = await prisma.inspeccionHistoricaOrigen.count();
  const porArchivo = await prisma.inspeccionHistoricaOrigen.groupBy({
    by: ['archivoOrigen'],
    _count: { id: true },
  });

  console.log(`2. DISTRIBUCIÓN EN inspecciones_historicas_origen (${totalHistorico.toLocaleString()} registros totales):`);
  for (const row of porArchivo) {
    console.log(`   - ${(row.archivoOrigen || 'NULL').padEnd(28)}: ${row._count.id.toLocaleString()} registros`);
  }

  // Diagnosticar ADORNO en la base de datos
  const adornoCabeceras = await prisma.inspeccionCabecera.count({
    where: { departamentoAuditoria: { codigo: 'ADORNO' } },
  });
  const lotesFicticios = await prisma.produccionLote.findMany({
    where: {
      OR: [{ lote: { startsWith: 'LOTE-' } }, { lote: 'SIN_LOTE' }],
    },
    select: { id: true, lote: true, modelo: true, cantidad: true },
  });

  console.log('\n3. DIAGNÓSTICO DE ADORNO Y LOTES EN BASE DE DATOS:');
  console.log(`   - Cabeceras con depto ADORNO:         ${adornoCabeceras.toLocaleString()}`);
  console.log(`   - Lotes sintéticos/ficticios en BD:   ${lotesFicticios.map(l => `${l.lote} (id=${l.id})`).join(', ') || 'Ninguno (✓ Limpio)'}`);

  // 4. Verificar que en los registros actuales en BD la tupla (archivoOrigen, anioOrigen, noOriginal) sea 100% única
  const allHist = await prisma.inspeccionHistoricaOrigen.findMany({
    select: { id: true, archivoOrigen: true, noOriginal: true, fechaParseada: true, fechaTexto: true },
  });

  const seenKey = new Map<string, number>();
  const dupsInDb: Array<{ key: string; firstId: number; secondId: number }> = [];

  for (const r of allHist) {
    let year = r.fechaParseada ? r.fechaParseada.getUTCFullYear() : 0;
    if (!year && r.fechaTexto) {
      const m = r.fechaTexto.match(/(\d{4})/);
      if (m) year = parseInt(m[1], 10);
    }
    const key = `${r.archivoOrigen}|${year}|${r.noOriginal}`;
    if (seenKey.has(key)) {
      dupsInDb.push({ key, firstId: seenKey.get(key)!, secondId: r.id });
    } else {
      seenKey.set(key, r.id);
    }
  }

  console.log(`\n4. UNICIDAD DE (archivoOrigen, anioOrigen, noOriginal) EN LOS ${allHist.length.toLocaleString()} REGISTROS DE BD:`);
  console.log(`   - Colisiones detectadas en BD: ${dupsInDb.length} ${dupsInDb.length === 0 ? '(✓ 100% Único, listo para migrate deploy)' : '✗ Hay colisiones'}`);

  // 5. Verificar directorio de archivos TXT
  let hDir: string;
  try {
    hDir = legacyIncrementalSyncService.resolveBaseDir();
    console.log(`\n5. DIRECTORIO ORIGEN DE ARCHIVOS TXT:`);
    console.log(`   - Ruta resuelta: ${hDir}`);
  } catch (err: any) {
    console.warn(`\n5. DIRECTORIO ORIGEN DE ARCHIVOS TXT:\n   - Advertencia: ${err.message}`);
    return;
  }

  const txtFiles = [
    'Defectos_Acabado.txt',
    'Defectos_Avios.txt',
    'Defectos_Bordado.txt',
    'Defectos_corte.txt',
    'Defectos_Montado.txt',
    'Defectos_Pespunte.txt',
    'Defectos_Preliminares.txt',
  ];

  console.log('\n6. VERIFICACIÓN DE REINICIOS DE CONSECUTIVO DENTRO DEL MISMO AÑO EN TXT:');
  for (const file of txtFiles) {
    const fp = path.join(hDir, file);
    if (!fs.existsSync(fp)) {
      console.log(`   - ${file.padEnd(26)}: Archivo no encontrado en ${hDir}`);
      continue;
    }
    const lines = fs.readFileSync(fp, 'latin1').split(/\r?\n/).filter(l => l.trim().length > 0);
    const seenInYear = new Set<string>();
    let collisionsInSameYear = 0;
    let resetsInSameYear = 0;
    const prevNoByYear = new Map<string, number>();

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split('\t').map(p => p.trim());
      if (parts[0] === 'No') continue;
      const noStr = parts[0] || '';
      const noNum = parseInt(noStr, 10);
      const m = (parts[2] || '').match(/(\d{4})/);
      const year = m ? m[1] : '0000';

      const yk = `${year}|${noStr}`;
      if (seenInYear.has(yk)) {
        collisionsInSameYear++;
      }
      seenInYear.add(yk);

      const prevNo = prevNoByYear.get(year) || 0;
      if (noNum < prevNo && prevNo - noNum > 500) {
        resetsInSameYear++;
      }
      prevNoByYear.set(year, noNum);
    }
    console.log(
      `   - ${file.padEnd(26)}: Colisiones (Año+No)=${collisionsInSameYear} | Reinicios mismo año=${resetsInSameYear}`
    );
  }

  console.log('\n========================================================================');
  console.log('DIAGNÓSTICO COMPLETADO CON ÉXITO: PROCEDA CON LA MIGRACIÓN Y BACKFILL.');
  console.log('========================================================================\n');
}

main()
  .catch(err => {
    console.error('Error durante el diagnóstico pre-migración:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

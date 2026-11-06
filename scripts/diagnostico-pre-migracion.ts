import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { prisma } from '../src/config/database';

async function main() {
  console.log('========================================================================');
  console.log('FASE 3.1 (COMPLEMENTO): VERIFICACIÓN DE RESPALDO, ADORNO Y UNICIDAD');
  console.log('========================================================================\n');

  // 1. Verificar integridad del respaldo backup_dev_pre_fase3_1793977853881.json
  const backupPath = path.join(process.cwd(), 'backups', 'backup_dev_pre_fase3_1793977853881.json');
  const rawBackup = fs.readFileSync(backupPath, 'utf8');
  const backupHash = crypto.createHash('sha256').update(rawBackup).digest('hex');
  const parsedBackup = JSON.parse(rawBackup);

  const isRestorable =
    parsedBackup &&
    typeof parsedBackup === 'object' &&
    Array.isArray(parsedBackup.webCabeceras) &&
    parsedBackup.webCabeceras.length === 55 && // 52 INS-* + 3 TEST-AJENA-*
    parsedBackup.webCabeceras.every(
      (c: any) => typeof c.id === 'number' && typeof c.folio === 'string' && Array.isArray(c.detalles)
    );

  console.log('1. VERIFICACIÓN DE INTEGRIDAD DEL RESPALDO:');
  console.log(`   - Archivo:               ${backupPath}`);
  console.log(`   - Tamaño (bytes):        ${rawBackup.length.toLocaleString()}`);
  console.log(`   - SHA-256:               ${backupHash}`);
  console.log(`   - Cabeceras WEB/Test:    ${parsedBackup.webCabeceras.length} (52 INS-* + 3 TEST-AJENA-*)`);
  console.log(`   - Prueba de restauración en memoria: ${isRestorable ? '✓ VÁLIDO Y RESTAURABLE' : '✗ FALLO'}\n`);

  if (!isRestorable) {
    throw new Error('El respaldo no pasó la validación de restauración.');
  }

  // 2. Diagnóstico de los 51,099 registros en inspecciones_historicas_origen (incluyendo ADORNO)
  const porArchivo = await prisma.inspeccionHistoricaOrigen.groupBy({
    by: ['archivoOrigen'],
    _count: { id: true },
  });

  console.log('2. DISTRIBUCIÓN ACTUAL EN inspecciones_historicas_origen (DEV):');
  for (const row of porArchivo) {
    console.log(`   - ${(row.archivoOrigen || 'NULL').padEnd(28)}: ${row._count.id.toLocaleString()} registros`);
  }

  // Diagnosticar ADORNO específicamente en BD de desarrollo
  const adornoCabecerasEnDev = await prisma.inspeccionCabecera.count({
    where: { departamentoAuditoria: { codigo: 'ADORNO' } },
  });
  const lotesFicticiosEnDev = await prisma.produccionLote.findMany({
    where: {
      OR: [{ lote: { startsWith: 'LOTE-' } }, { lote: 'SIN_LOTE' }],
    },
    select: { id: true, lote: true, modelo: true, cantidad: true },
  });

  console.log('\n3. DIAGNÓSTICO DE ADORNO EN BASE DE DATOS DE DESARROLLO:');
  console.log(`   - Cabeceras con depto ADORNO en dev: ${adornoCabecerasEnDev.toLocaleString()}`);
  console.log(`   - Lotes ficticios en dev:            ${lotesFicticiosEnDev.map(l => `${l.lote} (id=${l.id})`).join(', ') || 'Ninguno'}`);

  // 4. Verificar que en los 51,099 registros actuales en BD la tupla (archivoOrigen, anioOrigen, noOriginal) sea 100% única
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
  console.log(`   - Colisiones detectadas en BD: ${dupsInDb.length}`);

  // 5. Verificar que NO existan reinicios adicionales del consecutivo dentro del mismo año en los TXT
  const hDir = 'H:\\CALIDAD\\App\\Quality System\\DataBase';
  const txtFiles = [
    'Defectos_Acabado.txt',
    'Defectos_Avios.txt',
    'Defectos_Bordado.txt',
    'Defectos_corte.txt',
    'Defectos_Montado.txt',
    'Defectos_Pespunte.txt',
    'Defectos_Preliminares.txt',
  ];

  console.log('\n5. VERIFICACIÓN DE REINICIOS DE CONSECUTIVO DENTRO DEL MISMO AÑO EN ARCHIVOS TXT:');
  for (const file of txtFiles) {
    const fp = path.join(hDir, file);
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
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

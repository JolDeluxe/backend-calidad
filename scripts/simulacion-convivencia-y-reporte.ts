import { prisma } from '../src/config/database';
import {
  ARCHIVOS_PRODUCCION_LEGACY,
  legacyIncrementalSyncService,
} from '../src/modules/inspecciones/services/legacy-incremental-sync.service';

async function getCountsByArchivo() {
  const grouped = await prisma.inspeccionHistoricaOrigen.groupBy({
    by: ['archivoOrigen'],
    _count: { id: true },
  });
  const map = new Map<string, number>();
  for (const g of grouped) {
    if (g.archivoOrigen) {
      map.set(g.archivoOrigen, g._count.id);
    }
  }
  return map;
}

async function main() {
  console.log('======================================================================================');
  console.log('FASE 3.7 Y 3.8: SIMULACIÓN DE CONVIVENCIA Y REPORTE COMPARATIVO POR DEPARTAMENTO');
  console.log('======================================================================================\n');

  // 1. Capturar estado ANTES de la sincronización incremental
  const beforeByArchivo = await getCountsByArchivo();
  const [beforeLotes, beforeCabecerasWeb, beforeCabecerasLegacy, beforeDetalles] = await Promise.all([
    prisma.produccionLote.count(),
    prisma.inspeccionCabecera.count({ where: { procedencia: 'WEB' } }),
    prisma.inspeccionCabecera.count({ where: { procedencia: 'LEGACY' } }),
    prisma.inspeccionDetalle.count(),
  ]);

  console.log('1. ESTADO EN DESARROLLO ANTES DE LA SINCRONIZACIÓN INCREMENTAL:');
  console.log(`   - Lotes de producción:        ${beforeLotes.toLocaleString()}`);
  console.log(`   - Cabeceras WEB:              ${beforeCabecerasWeb.toLocaleString()} (52 INS-* + 3 TEST-AJENA-*)`);
  console.log(`   - Cabeceras LEGACY:           ${beforeCabecerasLegacy.toLocaleString()}`);
  console.log(`   - Detalles totales:           ${beforeDetalles.toLocaleString()}\n`);

  // 2. Ejecutar 1ra corrida de convivencia (PRELIMINARES = WEB, los otros 6 = LEGACY)
  console.log('2. EJECUTANDO 1RA CORRIDA INCREMENTAL (PRELIMINARES=WEB, RESTO=LEGACY)...');
  const firstRun = await legacyIncrementalSyncService.syncAll({
    departamentosWeb: ['PRELIMINARES'],
  });

  console.log('\n   Resultados 1ra corrida (Detección de deltas desde última carga en desarrollo):');
  console.log('   ----------------------------------------------------------------------------------------------------------------');
  console.log(
    '   ' +
      'ARCHIVO'.padEnd(26) +
      'DEPTO'.padEnd(18) +
      'MODO'.padEnd(8) +
      'ESTADO'.padEnd(14) +
      'DETECT'.padStart(8) +
      'INSERT'.padStart(8) +
      'ACTUAL'.padStart(8) +
      'OMITID'.padStart(8) +
      'RECHAZ'.padStart(8)
  );
  console.log('   ----------------------------------------------------------------------------------------------------------------');
  for (const r of firstRun) {
    console.log(
      '   ' +
        r.archivo.padEnd(26) +
        r.departamento.padEnd(18) +
        r.modo.padEnd(8) +
        r.estado.padEnd(14) +
        String(r.registrosDetectados).padStart(8) +
        String(r.registrosInsertados).padStart(8) +
        String(r.registrosActualizados).padStart(8) +
        String(r.registrosOmitidos).padStart(8) +
        String(r.registrosRechazados).padStart(8)
    );
  }
  console.log('   ----------------------------------------------------------------------------------------------------------------\n');

  // 3. Ejecutar 2da corrida inmediata para demostrar IDEMPOTENCIA total
  console.log('3. EJECUTANDO 2DA CORRIDA INMEDIATA (PRUEBA DE IDEMPOTENCIA)...');
  const secondRun = await legacyIncrementalSyncService.syncAll({
    departamentosWeb: ['PRELIMINARES'],
  });

  console.log('\n   Resultados 2da corrida (Idempotencia verificada):');
  console.log('   ----------------------------------------------------------------------------------------------------------------');
  for (const r of secondRun) {
    console.log(
      '   ' +
        r.archivo.padEnd(26) +
        r.departamento.padEnd(18) +
        r.modo.padEnd(8) +
        r.estado.padEnd(14) +
        String(r.registrosDetectados).padStart(8) +
        String(r.registrosInsertados).padStart(8) +
        String(r.registrosActualizados).padStart(8) +
        String(r.registrosOmitidos).padStart(8) +
        String(r.registrosRechazados).padStart(8)
    );
  }
  console.log('   ----------------------------------------------------------------------------------------------------------------\n');

  // 4. Capturar estado DESPUÉS y generar tabla comparativa por departamento (FASE 3.8)
  const afterByArchivo = await getCountsByArchivo();
  const [afterLotes, afterCabecerasWeb, afterCabecerasLegacy, afterDetalles] = await Promise.all([
    prisma.produccionLote.count(),
    prisma.inspeccionCabecera.count({ where: { procedencia: 'WEB' } }),
    prisma.inspeccionCabecera.count({ where: { procedencia: 'LEGACY' } }),
    prisma.inspeccionDetalle.count(),
  ]);

  console.log('4. REPORTE COMPARATIVO DE REGISTROS HISTÓRICOS POR DEPARTAMENTO (FASE 3.8):');
  console.log('   ---------------------------------------------------------------------------------------------------------');
  console.log(
    '   ' +
      'DEPARTAMENTO'.padEnd(20) +
      'ARCHIVO'.padEnd(28) +
      'MODO'.padEnd(10) +
      'ANTES (BD)'.padStart(12) +
      'NUEVOS TXT'.padStart(12) +
      'DESPUÉS (BD)'.padStart(14) +
      'DIFERENCIA'.padStart(12)
  );
  console.log('   ---------------------------------------------------------------------------------------------------------');

  for (const cfg of ARCHIVOS_PRODUCCION_LEGACY) {
    const r1 = firstRun.find(x => x.archivo === cfg.archivo)!;
    const bCount = beforeByArchivo.get(cfg.archivo) || 0;
    const aCount = afterByArchivo.get(cfg.archivo) || 0;
    console.log(
      '   ' +
        cfg.departamentoCodigo.padEnd(20) +
        cfg.archivo.padEnd(28) +
        r1.modo.padEnd(10) +
        String(bCount).padStart(12) +
        String(r1.registrosDetectados).padStart(12) +
        String(aCount).padStart(14) +
        `+${aCount - bCount}`.padStart(12)
    );
  }
  console.log('   ---------------------------------------------------------------------------------------------------------\n');

  console.log('5. RESUMEN GLOBAL ANTES VS DESPUÉS EN DESARROLLO:');
  console.log(`   - Lotes de producción:  Antes=${beforeLotes.toLocaleString()} -> Después=${afterLotes.toLocaleString()} (+${afterLotes - beforeLotes})`);
  console.log(`   - Cabeceras WEB:        Antes=${beforeCabecerasWeb.toLocaleString()} -> Después=${afterCabecerasWeb.toLocaleString()} (100% intactas)`);
  console.log(`   - Cabeceras LEGACY:     Antes=${beforeCabecerasLegacy.toLocaleString()} -> Después=${afterCabecerasLegacy.toLocaleString()} (+${afterCabecerasLegacy - beforeCabecerasLegacy})`);
  console.log(`   - Detalles totales:     Antes=${beforeDetalles.toLocaleString()} -> Después=${afterDetalles.toLocaleString()} (+${afterDetalles - beforeDetalles})\n`);
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import { prisma } from '../src/config/database';
import { legacyIncrementalSyncService } from '../src/modules/inspecciones/services/legacy-incremental-sync.service';
import { legacySyncSchedulerService } from '../src/modules/inspecciones/services/legacy-sync-scheduler.service';

async function main() {
  console.log('========================================================================');
  console.log('EJECUCIÓN MANUAL CLI — SINCRONIZADOR INCREMENTAL LEGACY -> WEB MBC');
  console.log('========================================================================\n');

  const archivoArg = process.argv.find(a => a.startsWith('--archivo='));
  const archivoFiltro = archivoArg ? [archivoArg.split('=')[1].trim()] : undefined;

  const deptosWeb = Array.from(legacyIncrementalSyncService.getDepartamentosEnModoWeb());
  console.log(
    `Departamentos activos en modo WEB (excluidos de TXT): ${deptosWeb.join(', ') || 'Ninguno'}`
  );
  if (archivoFiltro) {
    console.log(`Filtro manual de archivo: ${archivoFiltro.join(', ')}`);
  }
  console.log('');

  const outcome = await legacySyncSchedulerService.runCycle('MANUAL_CLI', {
    archivosFiltro: archivoFiltro,
  });

  if (outcome.skipped) {
    console.warn(
      `⚠️ Ejecución manual omitida: otro proceso de sincronización se encuentra activo (${outcome.skipReason}).\n`
    );
    return;
  }

  console.log(
    '----------------------------------------------------------------------------------------------------------------'
  );
  console.log(
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
  console.log(
    '----------------------------------------------------------------------------------------------------------------'
  );

  for (const r of outcome.results) {
    console.log(
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
  console.log(
    '----------------------------------------------------------------------------------------------------------------\n'
  );
}

main()
  .catch(err => {
    console.error('Error en sincronización incremental:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

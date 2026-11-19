import fs from 'fs';
import path from 'path';
import { prisma } from '../src/config/database';
import { importarLotesDesdeCSV } from '../src/modules/lotes/services/lotes-import.service';

/**
 * Script de Reconciliación del Catálogo Maestro de Lotes de Producción.
 * Sincroniza MySQL con el archivo autoritativo 'Calidad Datos Base.csv'.
 *
 * Uso:
 *   bun prisma/seed-lotes.ts --dry-run     (Modo Previsualización: no aplica cambios en BD)
 *   bun prisma/seed-lotes.ts --apply       (Modo Ejecución: aplica reconciliación completa)
 */
async function resolverRutaLotesCSV(): Promise<string> {
  const candidatePaths = [
    process.env.LOTES_CSV_PATH,
    'H:\\CALIDAD\\App\\Quality System\\DataBase\\Calidad Datos Base.csv',
    '\\\\200.1.1.58\\usuariosmbc\\CALIDAD\\App\\Quality System\\DataBase\\Calidad Datos Base.csv',
    'C:\\Servidor\\Aplicaciones\\Calidad-MBC\\Documentacion\\DtaosBse\\Calidad Datos Base.csv',
    'C:\\Users\\MBCPROEW10028\\Downloads\\DtaosBse\\Calidad Datos Base.csv',
  ].filter((p): p is string => Boolean(p));

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.size > 0) {
          console.log(`✓ Archivo maestro de lotes encontrado en: ${p} (${stat.size.toLocaleString()} bytes)`);
          return p;
        }
      }
    } catch (err: any) {
      console.warn(`⚠️ Ruta no accesible: ${p} (${err.message})`);
    }
  }

  throw new Error(
    `[ERROR CRÍTICO]: No se encontró el archivo 'Calidad Datos Base.csv' en ninguna de las rutas evaluadas:\n${candidatePaths.map((p) => ` - ${p}`).join('\n')}`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const esApply = args.includes('--apply') || args.includes('--confirm');
  const esDryRun = args.includes('--dry-run') || args.includes('--preview') || !esApply;

  console.log('=================================================================');
  console.log(`RECONCILIACIÓN DEL CATÁLOGO DE LOTES — MBC [${esDryRun ? 'MODO PREVISUALIZACIÓN' : 'MODO EJECUCIÓN'}]`);
  console.log('=================================================================');

  if (esDryRun) {
    console.log('ℹ️  Ejecutando en MODO PREVISUALIZACIÓN (dry-run). No se mutará la base de datos.');
    console.log('    Para autorizar y aplicar la reconciliación real ejecute:');
    console.log('    bun prisma/seed-lotes.ts --apply\n');
  } else {
    console.log('⚠️  MODO EJECUCIÓN AUTORIZADO: Se aplicará la reconciliación completa en MySQL.\n');
  }

  const filePath = await resolverRutaLotesCSV();
  console.log('Procesando archivo CSV:', filePath);

  const superAdmin = await prisma.usuario.findFirst({
    where: { OR: [{ rol: { codigo: 'SUPER_ADMIN' } }, { usuario: 'admin' }] },
    select: { id: true },
  });

  const res = await importarLotesDesdeCSV({
    filePath,
    usuarioId: superAdmin?.id || 1,
    batchSize: 200,
    dryRun: esDryRun,
    permitirInactivacion: true,
    origenDisparador: esDryRun ? 'CLI_PREVIEW' : 'CLI_APPLY',
  });

  console.log('\n=================================================================');
  console.log(`RESUMEN DE RECONCILIACIÓN [${res.dryRun ? 'PREVISUALIZACIÓN ESTIMADA' : 'APLICADO EN BASE DE DATOS'}]:`);
  console.log(`  -> Total leídos en CSV: ${res.totalLeidos.toLocaleString()}`);
  console.log(`  -> Nuevos a insertar:   ${res.insertados.toLocaleString()}`);
  console.log(`  -> Existentes a actual: ${res.actualizados.toLocaleString()}`);
  console.log(`  -> Inactivos a reactiv: ${res.reactivados.toLocaleString()}`);
  console.log(`  -> Idénticos (omitir):  ${res.omitidos.toLocaleString()}`);
  console.log(`  -> Ausentes a inactivar:${res.inactivados.toLocaleString()}`);
  console.log(`  -> Rechazados / Error:  ${res.rechazados.toLocaleString()}`);
  console.log(`  -> Duración cálculo:    ${(res.duracionMs / 1000).toFixed(2)}s`);
  console.log(`  -> Hash SHA-256:        ${res.hashSha256 || 'N/A'}`);
  console.log('=================================================================');

  if (res.anomalias.length > 0) {
    console.log(`\nℹ️  Anomalías informativas detectadas (${res.anomalias.length}):`);
    for (const anom of res.anomalias.slice(0, 5)) {
      console.log(`   - Fila ${anom.fila} [${anom.lista || ''}-${anom.lote || ''}]: ${anom.motivo}`);
    }
    if (res.anomalias.length > 5) {
      console.log(`   ... y ${res.anomalias.length - 5} más.`);
    }
  }

  const activosEnBD = await prisma.produccionLote.count({ where: { estado: 'ACTIVO' } });
  const inactivosEnBD = await prisma.produccionLote.count({ where: { estado: 'INACTIVO' } });
  console.log(`\n✓ Estado actual en BD: ${activosEnBD.toLocaleString()} ACTIVOS, ${inactivosEnBD.toLocaleString()} INACTIVOS (Total: ${(activosEnBD + inactivosEnBD).toLocaleString()})`);
}

main()
  .catch((e) => {
    console.error('Error en reconciliación de lotes:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

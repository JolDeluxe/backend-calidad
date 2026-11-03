import fs from 'fs';
import path from 'path';
import { prisma } from '../src/config/database';
import { importarLotesDesdeCSV } from '../src/modules/lotes/services/lotes-import.service';

/**
 * Script de importación y actualización del maestro de lotes de producción
 * desde el archivo CSV oficial 'Calidad Datos Base.csv'.
 *
 * Busca de forma segura en las rutas locales y de producción:
 * 1. C:\Servidor\Aplicaciones\Calidad-MBC\Documentacion\DtaosBse\Calidad Datos Base.csv
 * 2. C:\Users\MBCPROEW10028\Downloads\DtaosBse\Calidad Datos Base.csv
 * 3. H:\CALIDAD\App\Quality System\DataBase\Calidad Datos Base.csv
 * 4. Ruta UNC del servidor de archivos
 */
async function resolverRutaLotesCSV(): Promise<string> {
  const candidatePaths = [
    process.env.LOTES_CSV_PATH,
    'C:\\Servidor\\Aplicaciones\\Calidad-MBC\\Documentacion\\DtaosBse\\Calidad Datos Base.csv',
    'C:\\Users\\MBCPROEW10028\\Downloads\\DtaosBse\\Calidad Datos Base.csv',
    'H:\\CALIDAD\\App\\Quality System\\DataBase\\Calidad Datos Base.csv',
    '\\\\200.1.1.58\\usuariosmbc\\CALIDAD\\App\\Quality System\\DataBase\\Calidad Datos Base.csv',
    '\\\\GC-SRV-ARCHI-01.gc.com\\USUARIOSMBC\\CALIDAD\\App\\Quality System\\DataBase\\Calidad Datos Base.csv',
  ].filter((p): p is string => Boolean(p));

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.size > 0) {
          console.log(`✓ Archivo maestro de lotes encontrado en: ${p} (${stat.size.toLocaleString()} bytes)`);
          return p;
        }
      } else if (p.startsWith('\\\\')) {
        // En rutas UNC probamos sincronizar con robocopy hacia una carpeta temporal de prueba
        const tempFile = path.join(process.env.TEMP || 'C:\\Windows\\Temp', `test_lotes_${Date.now()}.csv`);
        Bun.spawnSync(['robocopy', path.dirname(p), path.dirname(tempFile), path.basename(p), '/NP', '/NFL', '/NDL']);
        if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 0) {
          fs.rmSync(tempFile, { force: true });
          return p;
        }
      }
    } catch (err: any) {
      console.warn(`⚠️ Ruta de lotes no accesible: ${p} (${err.message})`);
    }
  }

  throw new Error(
    `[ERROR CRÍTICO]: No se encontró el archivo 'Calidad Datos Base.csv' en ninguna de las rutas evaluadas:\n${candidatePaths.map(p => ` - ${p}`).join('\n')}`
  );
}

async function main() {
  console.log('=================================================================');
  console.log('INICIANDO IMPORTACIÓN MAESTRA DE LOTES DE PRODUCCIÓN');
  console.log('=================================================================');

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
  });

  console.log('\n=================================================================');
  console.log('RESUMEN DE IMPORTACIÓN DE LOTES DE PRODUCCIÓN:');
  console.log(`  -> Total leídos en CSV: ${res.totalLeidos.toLocaleString()}`);
  console.log(`  -> Nuevos insertados:  ${res.insertados.toLocaleString()}`);
  console.log(`  -> Actualizados:       ${res.actualizados.toLocaleString()}`);
  console.log(`  -> Sin cambios:        ${res.omitidos.toLocaleString()}`);
  console.log(`  -> Rechazados/Errores: ${res.rechazados.toLocaleString()}`);
  console.log(`  -> Duración:           ${(res.duracionMs / 1000).toFixed(2)}s`);
  console.log('=================================================================');

  const totalEnBD = await prisma.produccionLote.count();
  console.log(`✓ Total de lotes vigentes en base de datos: ${totalEnBD.toLocaleString()}`);
}

main()
  .catch((e) => {
    console.error('Error fatal en importación de lotes:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

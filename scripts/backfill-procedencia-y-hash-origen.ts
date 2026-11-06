import { prisma } from '../src/config/database';
import { calcularHashFilaCanonico } from '../src/modules/inspecciones/services/legacy-incremental-sync.service';

async function main() {
  console.log('========================================================================');
  console.log('FASE 3.2: VERIFICACIÓN DE BACKFILL DE PROCEDENCIA Y HASH CANÓNICO');
  console.log('========================================================================\n');

  // 1. Verificar distribución de procedencia en inspecciones_cabecera
  const porProcedencia = await prisma.inspeccionCabecera.groupBy({
    by: ['procedencia'],
    _count: { id: true },
  });

  console.log('1. DISTRIBUCIÓN DE PROCEDENCIA EN inspecciones_cabecera:');
  for (const row of porProcedencia) {
    console.log(`   - ${row.procedencia.padEnd(10)}: ${row._count.id.toLocaleString()} registros`);
  }

  // Documentar explícitamente los 3 registros TEST-AJENA-*
  const testAjena = await prisma.inspeccionCabecera.findMany({
    where: { folio: { startsWith: 'TEST-AJENA-' } },
    select: { id: true, folio: true, procedencia: true, fechaInspeccion: true },
  });
  console.log('\n2. REGISTROS TEST-AJENA DOCUMENTADOS Y CONSERVADOS:');
  for (const t of testAjena) {
    console.log(`   - id=${t.id} | folio=${t.folio} | procedencia=${t.procedencia}`);
  }

  // 2. Actualizar hashFila canónico en inspecciones_historicas_origen mediante CASE SQL rápido
  console.log('\n3. ACTUALIZANDO HASH CANÓNICO EN inspecciones_historicas_origen...');
  const BATCH = 1000;
  let cursorId = 0;
  let updatedCount = 0;

  while (true) {
    const rows = await prisma.inspeccionHistoricaOrigen.findMany({
      take: BATCH,
      skip: cursorId > 0 ? 1 : 0,
      cursor: cursorId > 0 ? { id: cursorId } : undefined,
      orderBy: { id: 'asc' },
    });

    if (rows.length === 0) break;

    const casesAnio: string[] = [];
    const casesHash: string[] = [];
    const ids: number[] = [];

    for (const r of rows) {
      const anio = r.fechaParseada ? r.fechaParseada.getUTCFullYear() : r.anioOrigen || 2024;
      const fechaIso = r.fechaParseada ? r.fechaParseada.toISOString().split('T')[0] : '';
      const h = calcularHashFilaCanonico({
        archivoOrigen: r.archivoOrigen || '',
        anioOrigen: anio,
        noOriginal: r.noOriginal || '',
        fechaIso,
        lista: r.lista || 'N/A',
        lote: r.lote || '',
        lineaTexto: r.linea || 'L1',
        modelo: r.modelo || '',
        defDeptoTexto: r.defDepto || '',
        defectoClave: r.defectoClave || 0,
        pares: r.pares || 1,
        horma: r.horma || '',
        usuarioTexto: r.usuarioTexto || '',
      });

      ids.push(r.id);
      casesAnio.push(`WHEN ${r.id} THEN ${anio}`);
      casesHash.push(`WHEN ${r.id} THEN '${h}'`);
    }

    const sql = `
      UPDATE inspecciones_historicas_origen
      SET anio_origen = CASE id ${casesAnio.join(' ')} END,
          hash_fila = CASE id ${casesHash.join(' ')} END
      WHERE id IN (${ids.join(',')})
    `;
    await prisma.$executeRawUnsafe(sql);

    cursorId = rows[rows.length - 1].id;
    updatedCount += rows.length;
    process.stdout.write(`\r   -> Procesados: ${updatedCount.toLocaleString()} registros...`);
  }

  console.log(`\n   ✓ Total registros con hashFila canónico actualizado: ${updatedCount.toLocaleString()}\n`);
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

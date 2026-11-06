import fs from 'fs';
import path from 'path';
import { prisma } from '../src/config/database';

async function main() {
  console.log('========================================================================');
  console.log('EXPORTANDO HISTÓRICO GENERAL DE INSPECCIONES (CALIDAD MBC)');
  console.log('========================================================================\n');

  const countHistorico = await prisma.inspeccionHistoricaOrigen.count();
  console.log(`Total de registros en tabla origen: ${countHistorico.toLocaleString()}`);

  if (countHistorico === 0) {
    console.warn('No hay registros en inspecciones_historicas_origen.');
    return;
  }

  const outputPath = path.resolve(process.cwd(), 'historico_general_49k.csv');
  console.log(`Generando archivo CSV en:\n-> ${outputPath}\n`);

  const writeStream = fs.createWriteStream(outputPath, { encoding: 'utf8' });

  // Encabezados CSV compatibles con Excel (BOM UTF-8)
  writeStream.write('\ufeff');
  const headers = [
    'ID',
    'No Original',
    'Departamento Auditoria',
    'Fecha Texto',
    'Fecha Estandar',
    'Lista',
    'Lote',
    'Linea',
    'Modelo',
    'Descripcion',
    'Depto Responsable',
    'Clave Defecto',
    'Nombre Defecto',
    'Pares',
    'Horma',
    'Usuario / Inspector',
    'Archivo Origen',
  ];
  writeStream.write(headers.map(h => `"${h}"`).join(',') + '\r\n');

  const BATCH_SIZE = 5000;
  let cursorId = 0;
  let exported = 0;

  while (true) {
    const chunk = await prisma.inspeccionHistoricaOrigen.findMany({
      take: BATCH_SIZE,
      skip: cursorId > 0 ? 1 : 0,
      cursor: cursorId > 0 ? { id: cursorId } : undefined,
      orderBy: { id: 'asc' },
    });

    if (chunk.length === 0) break;

    for (const r of chunk) {
      const fechaIso = r.fechaParseada ? r.fechaParseada.toISOString().split('T')[0] : '';
      const row = [
        r.id,
        r.noOriginal ?? '',
        r.departamento ?? '',
        r.fechaTexto ?? '',
        fechaIso,
        r.lista ?? '',
        r.lote ?? '',
        r.linea ?? '',
        r.modelo ?? '',
        (r.descripcion ?? '').replace(/"/g, '""'),
        r.defDepto ?? '',
        r.defectoClave ?? '',
        (r.defectoNombre ?? '').replace(/"/g, '""'),
        r.pares ?? 0,
        r.horma ?? '',
        (r.usuarioTexto ?? '').replace(/"/g, '""'),
        r.archivoOrigen ?? '',
      ];

      writeStream.write(row.map(val => `"${val}"`).join(',') + '\r\n');
      cursorId = r.id;
    }

    exported += chunk.length;
    const pct = Math.floor((exported / countHistorico) * 100);
    process.stdout.write(`\rExportando: ${pct}% (${exported.toLocaleString()}/${countHistorico.toLocaleString()})`);
  }

  writeStream.end();
  console.log(`\n\n✓ ¡Listo! Archivo exportado exitosamente.`);
  console.log(`-> Ubicación: ${outputPath}`);
}

main()
  .catch(err => {
    console.error('Error durante la exportación:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

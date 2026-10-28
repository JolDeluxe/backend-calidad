import fs from 'node:fs';
import iconv from 'iconv-lite';
import { prisma } from '../src/config/database';

async function main() {
  console.log('--- Iniciando importación masiva de Defectos_Montado.txt ---');

  const filePath = 'C:/Users/MBCPROEW10028/Downloads/DtaosBse/Defectos_Montado.txt';
  const buffer = fs.readFileSync(filePath);
  const text = iconv.decode(buffer, 'latin1');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  console.log(`Leídas ${lines.length} líneas del archivo (incluyendo cabecera). Total a procesar: ${lines.length - 1}`);

  // 1. Obtener departamento MONTADO
  const deptoMontado = await prisma.departamento.findUnique({
    where: { codigo: 'MONTADO' },
  });
  if (!deptoMontado) {
    throw new Error('Departamento MONTADO no encontrado');
  }

  // 2. Obtener usuario para inspector
  const inspector = await prisma.usuario.findFirst({
    where: { estado: 'ACTIVO' },
    orderBy: { id: 'asc' },
  });
  if (!inspector) {
    throw new Error('No hay usuario activo en el sistema');
  }

  // 3. Catálogo de departamentos
  const deptosList = await prisma.departamento.findMany();
  const deptosMap = new Map<string, number>();
  for (const d of deptosList) {
    deptosMap.set(d.codigo.trim().toUpperCase(), d.id);
    deptosMap.set(d.nombre.trim().toUpperCase(), d.id);
  }

  // 4. Catálogo de defectos
  const defectosList = await prisma.defecto.findMany();
  const defectosMap = new Map<number, any>();
  for (const d of defectosList) {
    defectosMap.set(d.clave, d);
  }

  // 5. Cargar mapa de lotes existentes en memoria para inserción ultrarrápida
  const lotesExistentes = await prisma.produccionLote.findMany({
    select: { id: true, lote: true, horma: true },
  });
  const lotesMap = new Map<string, { id: number; horma: string | null }>();
  for (const l of lotesExistentes) {
    lotesMap.set(l.lote, { id: l.id, horma: l.horma });
  }

  console.log(`Lotes existentes en BD: ${lotesMap.size}. Identificando lotes nuevos...`);

  // Identificar lotes únicos en el archivo que no existan aún en BD
  const lotesNuevosMap = new Map<string, {
    listaLote: string;
    lista: string;
    lote: string;
    idProducto: string;
    modelo: string;
    cantidad: number;
    descripcion: string | null;
    cliente: string;
    horma: string | null;
    estado: 'ACTIVO';
  }>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 12) continue;

    const lista = cols[3]?.trim() || '';
    const loteCodigo = cols[4]?.trim() || '';
    const modelo = cols[6]?.trim() || 'S/M';
    const descripcionRaw = cols[7]?.trim() || '';
    const horma = cols[12]?.trim() || null;

    if (!loteCodigo) continue;

    if (!lotesMap.has(loteCodigo) && !lotesNuevosMap.has(loteCodigo)) {
      lotesNuevosMap.set(loteCodigo, {
        listaLote: `${lista}-${loteCodigo}`,
        lista: lista || 'S/L',
        lote: loteCodigo,
        idProducto: modelo,
        modelo: modelo,
        cantidad: 100,
        descripcion: descripcionRaw === 'NA' || !descripcionRaw ? null : descripcionRaw,
        cliente: '',
        horma: horma,
        estado: 'ACTIVO',
      });
    }
  }

  if (lotesNuevosMap.size > 0) {
    console.log(`Insertando ${lotesNuevosMap.size} nuevos lotes en lotes de 1000...`);
    const nuevosLotesArray = Array.from(lotesNuevosMap.values());
    const loteBatchSize = 1000;
    for (let i = 0; i < nuevosLotesArray.length; i += loteBatchSize) {
      const slice = nuevosLotesArray.slice(i, i + loteBatchSize);
      await prisma.produccionLote.createMany({
        data: slice,
        skipDuplicates: true,
      });
    }

    // Refrescar mapa de lotes
    const todosLotes = await prisma.produccionLote.findMany({
      select: { id: true, lote: true, horma: true },
    });
    for (const l of todosLotes) {
      lotesMap.set(l.lote, { id: l.id, horma: l.horma });
    }
    console.log(`Total lotes ahora en BD: ${lotesMap.size}`);
  }

  // Agrupar filas del archivo por inspección
  // Llave única de inspección: Lote + FechaISO + Linea
  interface FilaParsed {
    noOriginal: string;
    fecha: Date;
    loteCodigo: string;
    linea: string;
    horma: string | null;
    defectoId: number;
    defDeptoId: number;
    pares: number;
  }

  const inspeccionesAgrupadas = new Map<string, {
    loteId: number;
    fecha: Date;
    linea: string;
    horma: string | null;
    detalles: Array<{
      defectoId: number;
      defDeptoId: number;
      pares: number;
    }>;
  }>();

  let filasValidas = 0;
  let filasOmitidas = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 12) {
      filasOmitidas++;
      continue;
    }

    const noOriginal = cols[0]?.trim();
    const fechaRaw = cols[2]?.trim() || '';
    const loteCodigo = cols[4]?.trim() || '';
    let lineaRaw = cols[5]?.trim() || 'L1';
    const defDeptoTxt = cols[8]?.trim().toUpperCase() || 'MONTADO';
    const claveRaw = cols[9]?.trim() || '';
    const prsRaw = cols[11]?.trim() || '1';
    const hormaRaw = cols[12]?.trim() || null;

    // Normalizar línea
    if (lineaRaw.includes('L2') || lineaRaw === '2') {
      lineaRaw = 'L2';
    } else {
      lineaRaw = 'L1';
    }

    // Normalizar clave
    let claveNum = parseInt(claveRaw, 10);
    if (claveNum === 532) claveNum = 1532;

    const defectoDb = defectosMap.get(claveNum);
    if (!defectoDb) {
      filasOmitidas++;
      continue;
    }

    // Parsear fecha dd / mm / yyyy a medianoche UTC
    const dateParts = fechaRaw.split('/').map((s) => s.trim());
    if (dateParts.length !== 3) {
      filasOmitidas++;
      continue;
    }
    const dd = dateParts[0].padStart(2, '0');
    const mm = dateParts[1].padStart(2, '0');
    const yyyy = dateParts[2];
    const fecha = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);

    // Normalizar pares
    let pares = parseInt(prsRaw, 10);
    if (isNaN(pares) || pares <= 0) pares = 1;

    // Resolver depto responsable
    let defDeptoId = deptosMap.get(defDeptoTxt);
    if (!defDeptoId) {
      defDeptoId = defectoDb.departamentoId || deptoMontado.id;
    }
    const finalDefDeptoId: number = defDeptoId || deptoMontado.id;

    const loteInfo = lotesMap.get(loteCodigo);
    if (!loteInfo) {
      filasOmitidas++;
      continue;
    }

    const groupKey = `${loteCodigo}__${yyyy}-${mm}-${dd}__${lineaRaw}`;
    if (!inspeccionesAgrupadas.has(groupKey)) {
      inspeccionesAgrupadas.set(groupKey, {
        loteId: loteInfo.id,
        fecha,
        linea: lineaRaw,
        horma: hormaRaw || loteInfo.horma,
        detalles: [],
      });
    }

    inspeccionesAgrupadas.get(groupKey)!.detalles.push({
      defectoId: defectoDb.id,
      defDeptoId: finalDefDeptoId,
      pares,
    });

    filasValidas++;
  }

  console.log(`Filas válidas procesadas: ${filasValidas} agrupadas en ${inspeccionesAgrupadas.size} inspecciones.`);

  // Insertar en bloques ordenados
  const grupos = Array.from(inspeccionesAgrupadas.values());
  const batchSize = 250;
  let totalCabecerasInsertadas = 0;
  let totalDetallesInsertados = 0;

  console.log(`Guardando en base de datos en lotes de ${batchSize} inspecciones...`);

  for (let i = 0; i < grupos.length; i += batchSize) {
    const slice = grupos.slice(i, i + batchSize);

    await prisma.$transaction(
      async (tx) => {
        for (let j = 0; j < slice.length; j++) {
          const g = slice[j];
          const indiceGlobal = i + j + 1;
          const yyyymmdd = g.fecha.toISOString().split('T')[0].replace(/-/g, '');
          const folio = `HIST-MNT-${yyyymmdd}-${String(indiceGlobal).padStart(5, '0')}`;

          const cab = await tx.inspeccionCabecera.create({
            data: {
              folio,
              loteId: g.loteId,
              inspectorId: inspector.id,
              departamentoAuditoriaId: deptoMontado.id,
              lineaTexto: g.linea,
              horma: g.horma,
              estado: 'RECHAZADO',
              fechaInspeccion: g.fecha,
              notas: null,
              creadoPor: inspector.id,
              fechaCreacion: g.fecha,
            },
          });

          await tx.inspeccionDetalle.createMany({
            data: g.detalles.map((d) => ({
              inspeccionId: cab.id,
              defectoId: d.defectoId,
              defDeptoId: d.defDeptoId,
              paresDefectuosos: d.pares,
              notas: null,
              creadoPor: inspector.id,
              fechaCreacion: g.fecha,
            })),
          });

          totalCabecerasInsertadas++;
          totalDetallesInsertados += g.detalles.length;
        }
      },
      {
        timeout: 60000,
      }
    );

    if ((i + batchSize) % 1000 === 0 || i + batchSize >= grupos.length) {
      console.log(
        `Progreso: ${Math.min(i + batchSize, grupos.length)}/${grupos.length} inspecciones (${totalDetallesInsertados} defectos insertados)`
      );
    }
  }

  console.log('--- Importación Masiva Completada Exitosamente ---');
  console.log(`Inspecciones Cabecera creadas: ${totalCabecerasInsertadas}`);
  console.log(`Inspecciones Detalle (defectos) insertados: ${totalDetallesInsertados}`);
}

main()
  .catch((e) => {
    console.error('Error durante la importación:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

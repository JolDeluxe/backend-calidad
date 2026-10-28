import fs from 'node:fs';
import iconv from 'iconv-lite';
import { prisma } from '../src/config/database';

async function main() {
  console.log('--- Iniciando inserción de datos históricos Eliminados_Montado.txt ---');

  const filePath = 'C:/Users/MBCPROEW10028/Downloads/DtaosBse/Eliminados_Montado.txt';
  const buffer = fs.readFileSync(filePath);
  const text = iconv.decode(buffer, 'latin1');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  console.log(`Leídas ${lines.length} líneas del archivo (incluyendo cabecera).`);

  // Obtener departamento MONTADO (código 'MONTADO')
  let deptoMontado = await prisma.departamento.findUnique({
    where: { codigo: 'MONTADO' },
  });
  if (!deptoMontado) {
    throw new Error("Departamento MONTADO no encontrado");
  }

  // Asegurar que Montado tenga al menos 2 líneas configuradas
  if (deptoMontado.numeroLineas < 2) {
    await prisma.departamento.update({
      where: { id: deptoMontado.id },
      data: { numeroLineas: 2 },
    });
    console.log('Actualizado departamento MONTADO a 2 líneas de inspección.');
  }

  // Obtener usuario admin o primer usuario para inspector
  const inspector = await prisma.usuario.findFirst({
    where: { estado: 'ACTIVO' },
    orderBy: { id: 'asc' },
  });
  if (!inspector) {
    throw new Error("No hay usuario activo en el sistema");
  }

  // Cargar catálogo de departamentos
  const deptosList = await prisma.departamento.findMany();
  const deptosMap = new Map<string, number>();
  for (const d of deptosList) {
    deptosMap.set(d.codigo.toUpperCase(), d.id);
    deptosMap.set(d.nombre.toUpperCase(), d.id);
  }

  // Cargar catálogo de defectos
  const defectosList = await prisma.defecto.findMany();
  const defectosMap = new Map<number, any>();
  for (const d of defectosList) {
    defectosMap.set(d.clave, d);
  }

  let insertados = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 10) continue;

    const noOriginal = cols[0]?.trim();
    const deptoTxt = cols[1]?.trim()?.toUpperCase();
    const fechaRaw = cols[2]?.trim(); // " 19 / 06 / 2024 "
    const lista = cols[3]?.trim();
    const loteCodigo = cols[4]?.trim();
    let lineaRaw = cols[5]?.trim()?.toUpperCase() || 'L1';
    const modelo = cols[6]?.trim() || 'N/A';
    const descripcion = cols[7]?.trim() || '';
    const defDeptoTxt = cols[8]?.trim()?.toUpperCase() || 'MONTADO';
    let claveRaw = cols[9]?.trim();
    const defectoNombre = cols[10]?.trim();
    let prsRaw = cols[11]?.trim();
    const horma = cols[12]?.trim() || null;
    const usuarioOriginal = cols[13]?.trim() || '';

    // Normalizar línea
    if (deptoTxt === 'CORTE' || lineaRaw === 'N/A' || !lineaRaw) {
      lineaRaw = 'L1';
    } else if (lineaRaw.includes('L2')) {
      lineaRaw = 'L2';
    } else if (lineaRaw.includes('L1')) {
      lineaRaw = 'L1';
    } else {
      lineaRaw = 'L1';
    }

    // Normalizar clave de defecto
    let claveNum = parseInt(claveRaw, 10);
    if (claveNum === 532) {
      claveNum = 1532; // Sin escuadra
    }

    // Normalizar pares
    let pares = parseInt(prsRaw, 10);
    if (isNaN(pares) || pares <= 0) {
      pares = 1;
    }

    // Parsear fecha dd / mm / yyyy a medianoche UTC
    const dateParts = fechaRaw.split('/').map((s) => s.trim());
    let fechaInspeccion = new Date();
    if (dateParts.length === 3) {
      const dd = dateParts[0].padStart(2, '0');
      const mm = dateParts[1].padStart(2, '0');
      const yyyy = dateParts[2];
      fechaInspeccion = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
    }

    // 1. Asegurar o crear el Lote de Producción
    let loteDb = await prisma.produccionLote.findFirst({
      where: { lote: loteCodigo },
    });
    if (!loteDb) {
      loteDb = await prisma.produccionLote.create({
        data: {
          listaLote: `${lista}-${loteCodigo}`,
          lista: lista || 'S/L',
          lote: loteCodigo,
          idProducto: modelo,
          modelo: modelo,
          cantidad: 100, // Estimado representativo
          descripcion: descripcion,
          cliente: '',
          horma: horma,
          estado: 'ACTIVO',
        },
      });
    }

    // 2. Buscar defecto por clave
    const defectoDb = defectosMap.get(claveNum);
    if (!defectoDb) {
      console.warn(`Fila ${i}: Defecto con clave ${claveNum} no encontrado. Omitiendo.`);
      continue;
    }

    // 3. Resolver departamento responsable
    let defDeptoId = deptosMap.get(defDeptoTxt);
    if (!defDeptoId) {
      defDeptoId = defectoDb.departamentoId || deptoMontado.id;
    }
    const finalDefDeptoId: number = defDeptoId || deptoMontado.id;

    // 4. Crear InspeccionCabecera
    const yyyymmdd = fechaInspeccion.toISOString().split('T')[0].replace(/-/g, '');
    const folio = `HIST-MNT-${yyyymmdd}-${String(i).padStart(4, '0')}`;

    const cabecera = await prisma.inspeccionCabecera.create({
      data: {
        folio,
        loteId: loteDb.id,
        inspectorId: inspector.id,
        departamentoAuditoriaId: deptoMontado.id,
        lineaTexto: lineaRaw,
        horma: horma || loteDb.horma,
        estado: 'RECHAZADO',
        fechaInspeccion: fechaInspeccion,
        notas: null,
        creadoPor: inspector.id,
        fechaCreacion: fechaInspeccion,
      },
    });

    // 5. Crear InspeccionDetalle
    await prisma.inspeccionDetalle.create({
      data: {
        inspeccionId: cabecera.id,
        defectoId: defectoDb.id,
        defDeptoId: finalDefDeptoId,
        paresDefectuosos: pares,
        notas: null,
        creadoPor: inspector.id,
        fechaCreacion: fechaInspeccion,
      },
    });

    insertados++;
  }

  console.log(`\nInserción completada: ${insertados} registros insertados en MONTADO exitosamente.`);
}

main()
  .catch((e) => {
    console.error('Error durante la inserción:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

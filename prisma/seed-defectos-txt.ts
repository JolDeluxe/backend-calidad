import { prisma } from '../src/config/database';
import fs from 'fs';

/**
 * Script de importación del catálogo de defectos desde Catalogo_Def.txt
 *
 * Mapeo de columnas:
 * Col 0: Id (ignorado, se usa autoincrement o mapeo interno)
 * Col 1: Fecha (omitido por indicación explícita)
 * Col 2: Clave (ej: 1101)
 * Col 3: Departamento propietario (CORTE, PRELIMINARES, BORDADO Y LASER, PESPUNTE, MONTADO, AVIOS, ACABADO, ADORNO)
 * Col 4: Defecto (Descripción)
 * Col 5: Clasificación (Crítico => CRITICO, Mayor => MAYOR, Menor => MENOR)
 *
 * Matriz de etapas (R = Disponible/Permitido, T = No disponible/Bloqueado):
 * Col 6:  Corte (Depto 1)
 * Col 7:  Preliminares (Depto 2)
 * Col 8:  Kit Complementos (omitido por indicación explícita)
 * Col 9:  Bordado y Laser (Depto 3)
 * Col 10: Pespunte (Depto 4)
 * Col 11: Montado (Depto 5)
 * Col 12: Avios (Depto 7)
 * Col 13: Acabado (Depto 6)
 * Col 14: Adorno (Etapa operativa asignada a Depto 4 Pespunte)
 */

async function importarCatalogoDefectos() {
  const filePathPrimary = 'C:/Users/MBCPROEW10028/Downloads/DtaosBse/Catalogo_Def.txt';
  const filePathFallback = 'H:/CALIDAD/App/Quality System/DataBase/Catalogo_Def.txt';
  const filePath = fs.existsSync(filePathPrimary) ? filePathPrimary : filePathFallback;

  console.log('=================================================================');
  console.log('Iniciando importación de Defectos desde:');
  console.log(filePath);
  console.log('=================================================================');

  if (!fs.existsSync(filePath)) {
    throw new Error(`No se encontró el archivo en la ruta: ${filePath}`);
  }

  // 1. Obtener departamentos existentes en base de datos
  const deptos = await prisma.departamento.findMany();
  const deptoMapByCodigo = new Map<string, number>();
  for (const d of deptos) {
    deptoMapByCodigo.set(d.codigo, d.id);
  }

  // Mapeo de departamento propietario del TXT hacia el departamento real en BD
  const deptoPropietarioMap: Record<string, number> = {
    'CORTE': deptoMapByCodigo.get('CORTE') || 1,
    'PRELIMINARES': deptoMapByCodigo.get('PRELIMINARES') || 2,
    'BORDADO Y LASER': deptoMapByCodigo.get('BORDADO_Y_LASER') || 3,
    'PESPUNTE': deptoMapByCodigo.get('PESPUENTE') || 4,
    'MONTADO': deptoMapByCodigo.get('MONTADO') || 5,
    'AVIOS': deptoMapByCodigo.get('AVIOS') || 7,
    'ACABADO': deptoMapByCodigo.get('ACABADO') || 6,
    'ADORNO': deptoMapByCodigo.get('ADORNO') || 4,
  };

  // Definición de las etapas a evaluar (omitiendo Kit Complementos)
  const etapasConfig: Array<{ colIdx: number; deptoId: number; nombre: string }> = [
    { colIdx: 6, deptoId: deptoMapByCodigo.get('CORTE') || 1, nombre: 'Corte' },
    { colIdx: 7, deptoId: deptoMapByCodigo.get('PRELIMINARES') || 2, nombre: 'Preliminares' },
    { colIdx: 9, deptoId: deptoMapByCodigo.get('BORDADO_Y_LASER') || 3, nombre: 'Bordado y Laser' },
    { colIdx: 10, deptoId: deptoMapByCodigo.get('PESPUENTE') || 4, nombre: 'Pespunte' },
    { colIdx: 11, deptoId: deptoMapByCodigo.get('MONTADO') || 5, nombre: 'Montado' },
    { colIdx: 12, deptoId: deptoMapByCodigo.get('AVIOS') || 7, nombre: 'Avios' },
    { colIdx: 13, deptoId: deptoMapByCodigo.get('ACABADO') || 6, nombre: 'Acabado' },
    { colIdx: 14, deptoId: deptoMapByCodigo.get('ADORNO') || 4, nombre: 'Adorno' },
  ];

  const rawContent = fs.readFileSync(filePath, 'utf8');
  const lines = rawContent.split(/\r?\n/).filter((l) => l.trim().length > 0);

  console.log(`Líneas detectadas en archivo (incluyendo cabecera): ${lines.length}`);

  let insertados = 0;
  let etapasRegistradas = 0;
  let deptoRelaciones = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 5) continue;

    const claveRaw = cols[2]?.trim();
    const clave = parseInt(claveRaw, 10);
    const deptoOwnerTxt = cols[3]?.trim();
    const desc = cols[4]?.trim();
    const clasifTxt = cols[5]?.trim();

    if (isNaN(clave) || !desc) continue;

    // Normalizar clasificación
    let clasificacion: 'CRITICO' | 'MAYOR' | 'MENOR' = 'MENOR';
    const clasifNorm = clasifTxt.toLowerCase();
    if (clasifNorm.includes('cr') || clasifNorm.includes('crit')) {
      clasificacion = 'CRITICO';
    } else if (clasifNorm.includes('may')) {
      clasificacion = 'MAYOR';
    } else {
      clasificacion = 'MENOR';
    }

    const departamentoId = deptoPropietarioMap[deptoOwnerTxt] || 1;

    // 1. Upsert del defecto
    const defecto = await prisma.defecto.upsert({
      where: { clave },
      update: {
        defecto: desc,
        clasificacion,
        departamentoId,
        activo: true,
      },
      create: {
        clave,
        defecto: desc,
        clasificacion,
        departamento: {
          connect: { id: departamentoId },
        },
        creador: {
          connect: { id: 1 }, // Admin (SUPER_ADMIN)
        },
        activo: true,
      },
    });
    insertados++;

    // 2. Asociar el defecto con su departamento propietario en defectos_departamentos
    await prisma.defectoDepartamento.upsert({
      where: {
        unique_defecto_departamento: {
          defectoId: defecto.id,
          departamentoId,
        },
      },
      update: {
        activo: true,
      },
      create: {
        defectoId: defecto.id,
        departamentoId,
        activo: true,
      },
    });
    deptoRelaciones++;

    // 3. Registrar matriz de etapas (defectos_etapas)
    for (const etapa of etapasConfig) {
      const val = cols[etapa.colIdx]?.trim().toUpperCase();
      let permitido = false;

      if (val === 'R') {
        permitido = true;
      } else if (val === 'T') {
        permitido = false;
      } else {
        // Manejo especial para filas con espacios en blanco o casos especiales como clave 1632
        if (clave === 1632) {
          // Activo en Montado (5), Avíos (7) y Acabado (6)
          permitido = [5, 7, 6].includes(etapa.deptoId);
        } else {
          permitido = false;
        }
      }

      await prisma.defectoEtapa.upsert({
        where: {
          unique_defecto_etapa: {
            defectoId: defecto.id,
            departamentoId: etapa.deptoId,
          },
        },
        update: {
          permitido,
        },
        create: {
          defectoId: defecto.id,
          departamentoId: etapa.deptoId,
          permitido,
        },
      });
      etapasRegistradas++;
    }
  }

  console.log('\n=================================================================');
  console.log('Importación finalizada con éxito:');
  console.log(`- Defectos procesados/upserted: ${insertados}`);
  console.log(`- Asociaciones departamento-defecto: ${deptoRelaciones}`);
  console.log(`- Registros de matriz de etapas creados: ${etapasRegistradas}`);
  console.log('=================================================================');
}

importarCatalogoDefectos()
  .catch((err) => {
    console.error('Error durante la importación:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });

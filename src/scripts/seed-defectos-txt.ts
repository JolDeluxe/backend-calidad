import { prisma } from '../config/database';
import fs from 'fs';

async function seed() {
  console.log('--- Iniciando sincronización idempotente de catálogo de defectos y matriz de etapas ---');

  const deptos = await prisma.departamento.findMany({
    where: { estado: 'ACTIVO', eliminadoEn: null }
  });

  const deptoMapByName: Record<string, number> = {};
  deptos.forEach(d => {
    const norm = d.nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    deptoMapByName[norm] = d.id;
  });

  // Mapeo canónico explícito para departamentos propietarios
  const deptoPropietarioMap: Record<string, number> = {
    'CORTE': deptoMapByName['corte'] || 2,
    'PRELIMINARES': deptoMapByName['preliminares'] || 8,
    'BORDADO Y LASER': deptoMapByName['bordado y laser'] || 9,
    'PESPUNTE': deptoMapByName['pespunte'] || 5,
    'MONTADO': deptoMapByName['montado'] || 6,
    'AVIOS': deptoMapByName['avios'] || 10,
    'ACABADO': deptoMapByName['acabado'] || 7,
    'ADORNO': deptoMapByName['adorno'] || 11
  };

  // Solo las 8 etapas operativas reales de la línea BOTA
  const colEtapas: Array<{ name: string; deptoId: number; colIdx: number }> = [
    { name: 'Corte', deptoId: deptoMapByName['corte'] || 2, colIdx: 6 },
    { name: 'Preliminares', deptoId: deptoMapByName['preliminares'] || 8, colIdx: 7 },
    { name: 'Bordado y Laser', deptoId: deptoMapByName['bordado y laser'] || 9, colIdx: 9 },
    { name: 'Pespunte', deptoId: deptoMapByName['pespunte'] || 5, colIdx: 10 },
    { name: 'Montado', deptoId: deptoMapByName['montado'] || 6, colIdx: 11 },
    { name: 'Avios', deptoId: deptoMapByName['avios'] || 10, colIdx: 12 },
    { name: 'Acabado', deptoId: deptoMapByName['acabado'] || 7, colIdx: 13 },
    { name: 'Adorno', deptoId: deptoMapByName['adorno'] || 11, colIdx: 14 }
  ];

  const filePath = 'C:/Users/MBCPROEW10028/Downloads/DtaosBse/Catalogo_Def.txt';
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);

  let upsertCount = 0;
  let etapasSincronizadas = 0;
  let asociacionesDeptoCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split('\t');
    const clave = parseInt(p[2]?.trim(), 10);
    const desc = p[4]?.trim();
    if (!clave || !desc) continue;

    const deptoOwnerStr = p[3]?.trim();
    const departamentoId = deptoPropietarioMap[deptoOwnerStr] || deptoMapByName['corte'] || 2;

    let clasif = p[5]?.trim();
    let clasifEnum: 'CRITICO' | 'MAYOR' | 'MENOR' = 'MENOR';
    if (clasif?.toLowerCase().includes('cr')) clasifEnum = 'CRITICO';
    else if (clasif?.toLowerCase().includes('may')) clasifEnum = 'MAYOR';
    else clasifEnum = 'MENOR';

    // Upsert idempotente del defecto preservando relaciones existentes
    const def = await prisma.defecto.upsert({
      where: { clave },
      create: {
        clave,
        defecto: desc,
        clasificacion: clasifEnum,
        departamentoId,
        activo: true,
        creadoPor: 1
      },
      update: {
        defecto: desc,
        clasificacion: clasifEnum,
        departamentoId,
        activo: true
      }
    });
    upsertCount++;

    // Vincular el defecto con su departamento propietario en defectoDepartamento para visibilidad operativa en la línea BOTA
    await prisma.defectoDepartamento.upsert({
      where: {
        unique_defecto_departamento: {
          defectoId: def.id,
          departamentoId
        }
      },
      create: {
        defectoId: def.id,
        departamentoId,
        activo: true,
        creadoPor: 1
      },
      update: {
        activo: true
      }
    });
    asociacionesDeptoCount++;

    // Sincronizar etapas permitidas / bloqueadas
    for (const etapa of colEtapas) {
      const val = p[etapa.colIdx]?.trim();
      let permitido = false;

      if (val === 'R') {
        permitido = true;
      } else if (val === 'T') {
        permitido = false;
      } else {
        // Manejo especial de fila 207 (Clave 1632 Suela/Firme de hule con falla)
        if (clave === 1632) {
          // Operacionalmente activo en Montado (colEtapas[4]), Avíos (colEtapas[5]) y Acabado (colEtapas[6])
          permitido = [colEtapas[4].deptoId, colEtapas[5].deptoId, colEtapas[6].deptoId].includes(etapa.deptoId);
        } else {
          permitido = false;
        }
      }

      await prisma.defectoEtapa.upsert({
        where: {
          unique_defecto_etapa: {
            defectoId: def.id,
            departamentoId: etapa.deptoId
          }
        },
        create: {
          defectoId: def.id,
          departamentoId: etapa.deptoId,
          permitido,
          creadoPor: 1
        },
        update: {
          permitido
        }
      });
      etapasSincronizadas++;
    }
  }

  console.log(`Éxito total: ${upsertCount} defectos procesados, ${asociacionesDeptoCount} asociaciones a línea BOTA y ${etapasSincronizadas} registros en matriz de etapas sincronizados.`);
}

seed()
  .catch((err) => {
    console.error('Error durante seed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

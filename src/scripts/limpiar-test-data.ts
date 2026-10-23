import { prisma } from '../config/database';

async function main() {
  console.log('--- Iniciando limpieza de datos de test en la base de datos ---');

  // 1. Líneas de test o residuales (dejando únicamente BOTA y ACCESORIOS)
  const lineasResiduales = await prisma.linea.findMany({
    where: {
      OR: [
        { codigo: { startsWith: 'LIN_' } },
        { nombre: { contains: 'Test' } },
        { codigo: { in: ['L1', 'L2', 'L3', 'L4'] } }
      ]
    },
    select: { id: true }
  });
  if (lineasResiduales.length > 0) {
    const lIds = lineasResiduales.map(l => l.id);
    await prisma.departamentoLinea.deleteMany({ where: { lineaId: { in: lIds } } });
    await prisma.inspeccionCabecera.updateMany({
      where: { lineaId: { in: lIds } },
      data: { lineaId: 1 }
    });
    const lDel = await prisma.linea.deleteMany({ where: { id: { in: lIds } } });
    console.log(`Líneas de prueba eliminadas: ${lDel.count}`);
  }

  // 2. Departamentos de test
  const deptosResiduales = await prisma.departamento.findMany({
    where: {
      OR: [
        { codigo: { startsWith: 'DEP_' } },
        { nombre: { contains: 'Test' } },
        { nombre: { contains: 'Departamento Con Categoria' } }
      ]
    },
    select: { id: true }
  });
  if (deptosResiduales.length > 0) {
    const dIds = deptosResiduales.map(d => d.id);
    await prisma.departamentoLinea.deleteMany({ where: { departamentoId: { in: dIds } } });
    await prisma.defectoEtapa.deleteMany({ where: { departamentoId: { in: dIds } } });
    await prisma.defectoDepartamento.deleteMany({ where: { departamentoId: { in: dIds } } });
    await prisma.usuarioDepartamento.deleteMany({ where: { departamentoId: { in: dIds } } });
    await prisma.terminal.updateMany({
      where: { departamentoId: { in: dIds } },
      data: { departamentoId: 2 }
    });
    const dDel = await prisma.departamento.deleteMany({ where: { id: { in: dIds } } });
    console.log(`Departamentos de prueba eliminados: ${dDel.count}`);
  }

  // 3. Categorías de test
  const catDel = await prisma.categoriaDepartamento.deleteMany({
    where: { nombre: { startsWith: 'CAT_TEST_' } }
  });
  console.log(`Categorías de prueba eliminadas: ${catDel.count}`);

  // 4. Tipos de operación de test
  const tipDel = await prisma.tipoOperacion.deleteMany({
    where: { codigo: { startsWith: 'TIPO_' } }
  });
  console.log(`Tipos de operación de prueba eliminados: ${tipDel.count}`);

  // 5. Sesiones de test
  const sesDel = await prisma.sesion.deleteMany({
    where: {
      OR: [
        { refreshTokenHash: { contains: '_catalog_' } },
        { refreshTokenHash: { contains: '_test_' } },
        { refreshTokenHash: { contains: 'hash_test_' } }
      ]
    }
  });
  console.log(`Sesiones de prueba eliminadas: ${sesDel.count}`);

  // 6. Usuarios de test
  const usrResiduales = await prisma.usuario.findMany({
    where: {
      OR: [
        { usuario: { contains: 'test' } },
        { usuario: { contains: 'inspector_catalog' } }
      ]
    },
    select: { id: true }
  });
  if (usrResiduales.length > 0) {
    const uIds = usrResiduales.map(u => u.id);
    await prisma.sesion.deleteMany({ where: { usuarioId: { in: uIds } } });
    await prisma.usuarioDepartamento.deleteMany({ where: { usuarioId: { in: uIds } } });
    await prisma.usuarioPermiso.deleteMany({ where: { usuarioId: { in: uIds } } });
    const uDel = await prisma.usuario.deleteMany({ where: { id: { in: uIds } } });
    console.log(`Usuarios de prueba eliminados: ${uDel.count}`);
  }

  // 7. Defectos de prueba fuera del catálogo oficial (> 90000)
  const defResiduales = await prisma.defecto.findMany({
    where: { clave: { gte: 90000 } },
    select: { id: true }
  });
  if (defResiduales.length > 0) {
    const defIds = defResiduales.map(d => d.id);
    await prisma.defectoEtapa.deleteMany({ where: { defectoId: { in: defIds } } });
    await prisma.defectoDepartamento.deleteMany({ where: { defectoId: { in: defIds } } });
    await prisma.inspeccionDetalle.deleteMany({ where: { defectoId: { in: defIds } } });
    const defDel = await prisma.defecto.deleteMany({ where: { id: { in: defIds } } });
    console.log(`Defectos fuera de catálogo eliminados: ${defDel.count}`);
  }

  // 8. Estandarizar nombre de línea principal a "BOTA"
  const lineaBota = await prisma.linea.findFirst({
    where: { codigo: 'BOTA' }
  });
  if (lineaBota) {
    await prisma.linea.update({
      where: { id: lineaBota.id },
      data: { nombre: 'BOTA', estado: 'ACTIVO', eliminadoEn: null }
    });
    console.log('Línea BOTA estandarizada como activa.');
  }

  console.log('--- Limpieza completada con éxito ---');
}

main()
  .catch((e) => {
    console.error('Error durante la limpieza:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

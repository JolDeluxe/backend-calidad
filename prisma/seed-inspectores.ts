import { prisma } from '../src/config/database';
import { securityService } from '../src/modules/auth/services/security.service';

/**
 * Lista oficial de inspectores a dar de alta
 * Cada inspector activo se asigna con rol 'INSPECTOR' y vinculado a su departamento operativo.
 */
interface InspectorSeedData {
  nombre: string;
  usuario: string;
  passwordPlano: string;
  departamentoCodigo: string;
  inactivo?: boolean;
}

const INSPECTORES: InspectorSeedData[] = [
  {
    nombre: 'ANA LAURA AGUILAR',
    usuario: 'ana.aguilar',
    passwordPlano: '*01Cor_501',
    departamentoCodigo: 'CORTE',
  },
  {
    nombre: 'THELMA CRUZ',
    usuario: 'thelma.cruz',
    passwordPlano: '*01Pre_501',
    departamentoCodigo: 'PRELIMINARES',
  },
  {
    nombre: 'KEVIN ROBERTO CANCINO',
    usuario: 'kevin.cancino',
    passwordPlano: '*01Mon_501',
    departamentoCodigo: 'MONTADO',
  },
  {
    nombre: 'YOLANDA FLORES',
    usuario: 'yolanda.flores',
    passwordPlano: '*01pes_501',
    departamentoCodigo: 'PESPUENTE',
  },
  {
    nombre: 'JUAN DE DIOS PADILLA HERNANDEZ',
    usuario: 'juan.padilla',
    passwordPlano: '*01pes_501',
    departamentoCodigo: 'PESPUENTE',
  },
  {
    nombre: 'VANESSA JACQUELIN VALLECILLO',
    usuario: 'vanessa.vallecillo',
    passwordPlano: '*01Pes_502',
    departamentoCodigo: 'PESPUENTE',
  },
  {
    nombre: 'WENDY LIZBETH SANCHEZ',
    usuario: 'wendy.sanchez',
    passwordPlano: '*01Ado_501',
    departamentoCodigo: 'PESPUENTE', // Adorno / Pespunte
  },
  {
    nombre: 'ALBA MARISOL MUÑOZ',
    usuario: 'alba.munoz',
    passwordPlano: '*01Aca_501',
    departamentoCodigo: 'ACABADO',
  },
  {
    nombre: 'JACQUELINE MEZA',
    usuario: 'jacqueline.meza',
    passwordPlano: '*01Aca_502',
    departamentoCodigo: 'ACABADO',
  },
  {
    nombre: 'KARINA NOEMI CABRERA',
    usuario: 'karina.cabrera',
    passwordPlano: '*01Aca_503',
    departamentoCodigo: 'ACABADO',
  },
  {
    nombre: 'ALEJANDRO GUEVARA',
    usuario: 'alejandro.guevara',
    passwordPlano: '*01Aca_504',
    departamentoCodigo: 'ACABADO',
  },
  {
    nombre: 'ERIKA JACQUELIN ORTEGA',
    usuario: 'erika.ortega',
    passwordPlano: '*01Avi_501',
    departamentoCodigo: 'AVIOS',
  },
  {
    nombre: 'FRANCISCO ARTURO GONZALEZ',
    usuario: 'francisco.gonzalez',
    passwordPlano: '*01Pes_503',
    departamentoCodigo: 'PESPUENTE',
  },
  // Inspector histórico dado de baja lógica para conservar trazabilidad de auditorías 2024/2025
  {
    nombre: 'ULISES ISRAEL MORENO GALLEGOS',
    usuario: 'ulises.moreno',
    passwordPlano: '*01Uli_Hist_99',
    departamentoCodigo: 'ACABADO',
    inactivo: true,
  },
];

async function main() {
  console.log('=================================================================');
  console.log('Iniciando inserción de Inspectores de Calidad (Activos e Históricos)');
  console.log('=================================================================');

  // 1. Obtener el rol INSPECTOR (o crear si no existe)
  let rolInspector = await prisma.rol.findUnique({
    where: { codigo: 'INSPECTOR' },
  });

  if (!rolInspector) {
    rolInspector = await prisma.rol.create({
      data: {
        codigo: 'INSPECTOR',
        nombre: 'Inspector de Calidad',
        descripcion: 'Inspector operativo de líneas y departamentos de calidad',
        esSistema: false,
        estado: 'ACTIVO',
      },
    });
  }

  // 2. Cargar departamentos para mapear sus IDs
  const departamentos = await prisma.departamento.findMany();
  const deptoMap = new Map<string, number>();
  for (const d of departamentos) {
    deptoMap.set(d.codigo, d.id);
  }

  console.log(`Rol INSPECTOR localizado: ID ${rolInspector.id}`);

  // 3. Insertar o actualizar de forma idempotente cada inspector
  for (const item of INSPECTORES) {
    const passwordHash = securityService.hashPassword(item.passwordPlano);
    const deptoId = deptoMap.get(item.departamentoCodigo);

    if (!deptoId) {
      console.warn(`⚠️ Departamento "${item.departamentoCodigo}" no encontrado para ${item.nombre}.`);
    }

    const estado = item.inactivo ? 'INACTIVO' : 'ACTIVO';

    const usuario = await prisma.usuario.upsert({
      where: { usuario: item.usuario },
      update: {
        nombre: item.nombre,
        passwordHash,
        rolId: rolInspector.id,
        estado,
      },
      create: {
        usuario: item.usuario,
        nombre: item.nombre,
        passwordHash,
        rolId: rolInspector.id,
        estado,
      },
    });

    // Vincular departamento si existe
    if (deptoId) {
      await prisma.usuarioDepartamento.upsert({
        where: {
          usuarioId_departamentoId: {
            usuarioId: usuario.id,
            departamentoId: deptoId,
          },
        },
        update: {},
        create: {
          usuarioId: usuario.id,
          departamentoId: deptoId,
        },
      });
    }

    console.log(
      `✓ [ID ${usuario.id}] ${usuario.usuario} | ${usuario.nombre} | Depto: ${item.departamentoCodigo} (ID ${deptoId}) | Estado: ${estado}`
    );
  }

  console.log('\n=================================================================');
  console.log(`Inspectores procesados exitosamente: ${INSPECTORES.length}`);
  console.log('=================================================================');
}

main()
  .catch((err) => {
    console.error('Error al insertar inspectores:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });

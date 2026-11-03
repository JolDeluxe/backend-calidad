import { prisma } from '../src/config/database';

/**
 * Script de sincronización y aseguramiento de todos los roles oficiales
 * del Sistema de Calidad MBC y sus permisos asociados.
 *
 * Puede ejecutarse tanto en Desarrollo como en Producción de forma 100% segura e idempotente.
 */
async function main() {
  console.log('=================================================================');
  console.log('SINCRONIZANDO CATÁLOGO OFICIAL DE ROLES Y PERMISOS (CALIDAD MBC)');
  console.log('=================================================================');

  const ROLES_OFICIALES = [
    {
      codigo: 'SUPER_ADMIN',
      nombre: 'Super Administrador',
      descripcion: 'Acceso global y control total del sistema',
      esSistema: true,
      estado: 'ACTIVO' as const,
    },
    {
      codigo: 'ADMIN',
      nombre: 'Administrador',
      descripcion: 'Administración operativa, usuarios y catálogos',
      esSistema: false,
      estado: 'ACTIVO' as const,
    },
    {
      codigo: 'COORD',
      nombre: 'Coordinador',
      descripcion: 'Supervisión departamental y autorización de correcciones',
      esSistema: true,
      estado: 'ACTIVO' as const,
    },
    {
      codigo: 'INSPECTOR',
      nombre: 'Inspector de Calidad',
      descripcion: 'Captura operativa de defectos en terminales y departamentos autorizados',
      esSistema: true,
      estado: 'ACTIVO' as const,
    },
    {
      codigo: 'VISUALIZADOR',
      nombre: 'Visualizador',
      descripcion: 'Solo lectura y visualización global de reportes y registros',
      esSistema: true,
      estado: 'ACTIVO' as const,
    },
    {
      codigo: 'USUARIO',
      nombre: 'Usuario General',
      descripcion: 'Usuario estándar sin privilegios administrativos',
      esSistema: false,
      estado: 'ACTIVO' as const,
    },
  ];

  console.log('\n1. Sincronizando roles...');
  const rolesMap = new Map<string, number>();

  for (const r of ROLES_OFICIALES) {
    const rolDb = await prisma.rol.upsert({
      where: { codigo: r.codigo },
      update: {
        nombre: r.nombre,
        descripcion: r.descripcion,
        esSistema: r.esSistema,
        estado: r.estado,
      },
      create: {
        codigo: r.codigo,
        nombre: r.nombre,
        descripcion: r.descripcion,
        esSistema: r.esSistema,
        estado: r.estado,
      },
    });
    rolesMap.set(rolDb.codigo, rolDb.id);
    console.log(`  ✓ Rol [ID ${rolDb.id}] ${rolDb.codigo.padEnd(14)} -> ${rolDb.nombre}`);
  }

  // 2. Mapeo de permisos por rol
  const PERMISOS_POR_ROL: Record<string, string[]> = {
    SUPER_ADMIN: [
      'usuarios.consultar',
      'usuarios.crear',
      'usuarios.editar',
      'usuarios.desactivar',
      'roles.gestionar',
      'permisos.gestionar_excepciones',
      'departamentos.consultar',
      'departamentos.gestionar',
      'terminales.consultar',
      'terminales.gestionar',
      'defectos.capturar',
      'defectos.consultar_propios',
      'defectos.consultar_departamento',
      'defectos.corregir',
      'defectos.autorizar_correccion',
      'defectos.eliminar',
      'reportes.consultar',
      'auditoria.consultar',
      'sincronizacion.consultar',
      'sincronizacion.gestionar',
      'sistema.configurar',
    ],
    ADMIN: [
      'usuarios.consultar',
      'usuarios.crear',
      'usuarios.editar',
      'usuarios.desactivar',
      'departamentos.consultar',
      'terminales.consultar',
      'defectos.consultar_departamento',
      'defectos.corregir',
      'reportes.consultar',
      'auditoria.consultar',
    ],
    COORD: [
      'departamentos.consultar',
      'defectos.consultar_departamento',
      'defectos.corregir',
      'defectos.autorizar_correccion',
      'reportes.consultar',
    ],
    INSPECTOR: [
      'defectos.capturar',
      'defectos.consultar_propios',
      'defectos.eliminar',
    ],
    VISUALIZADOR: [
      'departamentos.consultar',
      'defectos.consultar_departamento',
      'reportes.consultar',
    ],
  };

  console.log('\n2. Sincronizando permisos por rol...');
  const todosLosPermisos = await prisma.permiso.findMany();
  const permisoMap = new Map<string, number>();
  for (const p of todosLosPermisos) {
    permisoMap.set(p.codigo, p.id);
  }

  for (const [rolCodigo, codigosPermisos] of Object.entries(PERMISOS_POR_ROL)) {
    const rolId = rolesMap.get(rolCodigo);
    if (!rolId) continue;

    let asignados = 0;
    for (const codigoPermiso of codigosPermisos) {
      const permisoId = permisoMap.get(codigoPermiso);
      if (!permisoId) {
        console.warn(`  ⚠️ Permiso no encontrado en BD: ${codigoPermiso}`);
        continue;
      }

      await prisma.rolPermiso.upsert({
        where: {
          rolId_permisoId: {
            rolId,
            permisoId,
          },
        },
        update: {
          estado: 'ACTIVO',
        },
        create: {
          rolId,
          permisoId,
          estado: 'ACTIVO',
        },
      });
      asignados++;
    }
    console.log(`  ✓ Rol ${rolCodigo.padEnd(14)}: ${asignados} permisos configurados.`);
  }

  console.log('\n=================================================================');
  console.log('Sincronización de roles y permisos completada exitosamente.');
  console.log('=================================================================');
}

main()
  .catch((e) => {
    console.error('Error fatal en seed de roles:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

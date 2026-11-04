import { prisma } from '../src/config/database';

/**
 * Script de replicación de configuración de Producción a Desarrollo.
 * Inserta de manera idempotente los catálogos base (tipos de operación, líneas,
 * departamentos, relaciones departamento-línea, roles y permisos)
 * respetando exactamente los IDs, códigos y nombres de Producción (foto 02-Nov-2026).
 */
async function replicarConfiguracionProduccion() {
  console.log('=================================================================');
  console.log('Iniciando replicación de datos de configuración de PRODUCCIÓN en DESARROLLO');
  console.log('=================================================================');

  // Comprobar entorno para garantizar seguridad absoluta
  const dbUrl = process.env.DATABASE_URL || '';
  if (!dbUrl.includes('10_proyecto_calidad_db') && !dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1')) {
    throw new Error(`Seguridad: DATABASE_URL (${dbUrl}) no parece ser una base de datos local de desarrollo. Abortando.`);
  }

  // A. TIPOS DE OPERACIÓN
  console.log('\n--- 1. Replicando Tipos de Operación ---');
  const tipoOp = await prisma.tipoOperacion.upsert({
    where: { codigo: 'PRODUCCION' },
    update: {
      nombre: 'PRODUCCIÓN',
      estado: 'ACTIVO',
    },
    create: {
      id: 1,
      codigo: 'PRODUCCION',
      nombre: 'PRODUCCIÓN',
      estado: 'ACTIVO',
    },
  });
  console.log(`✓ Tipo de operación: [ID ${tipoOp.id}] ${tipoOp.codigo} - ${tipoOp.nombre}`);

  // B. LÍNEAS
  console.log('\n--- 2. Replicando Líneas ---');
  const lineasData = [
    { id: 1, tipoOperacionId: 1, codigo: 'BOTA', nombre: 'BOTA', estado: 'ACTIVO' as const },
    { id: 2, tipoOperacionId: 1, codigo: 'ACCESORIOS', nombre: 'ACCESORIO', estado: 'ACTIVO' as const },
  ];

  for (const l of lineasData) {
    const res = await prisma.linea.upsert({
      where: {
        unique_tipo_linea_codigo: {
          tipoOperacionId: l.tipoOperacionId,
          codigo: l.codigo,
        },
      },
      update: {
        nombre: l.nombre,
        tipoOperacionId: l.tipoOperacionId,
        estado: l.estado,
      },
      create: {
        id: l.id,
        tipoOperacionId: l.tipoOperacionId,
        codigo: l.codigo,
        nombre: l.nombre,
        estado: l.estado,
      },
    });
    console.log(`✓ Línea: [ID ${res.id}] Código: "${res.codigo}" | Nombre: "${res.nombre}"`);
  }

  // C. DEPARTAMENTOS
  console.log('\n--- 3. Replicando Departamentos ---');
  const departamentosData = [
    { id: 1, codigo: 'CORTE', nombre: 'CORTE', estado: 'ACTIVO' as const, numeroLineas: 1 },
    { id: 2, codigo: 'PRELIMINARES', nombre: 'PRELIMINARES', estado: 'ACTIVO' as const, numeroLineas: 1 },
    { id: 3, codigo: 'BORDADO_Y_LASER', nombre: 'BORDADO Y LASER', estado: 'ACTIVO' as const, numeroLineas: 1 },
    { id: 4, codigo: 'PESPUNTE', nombre: 'PESPUNTE', estado: 'ACTIVO' as const, numeroLineas: 1 },
    { id: 5, codigo: 'MONTADO', nombre: 'MONTADO', estado: 'ACTIVO' as const, numeroLineas: 2 },
    { id: 6, codigo: 'ACABADO', nombre: 'ACABADO', estado: 'ACTIVO' as const, numeroLineas: 2 },
    { id: 7, codigo: 'AVIOS', nombre: 'AVIOS', estado: 'ACTIVO' as const, numeroLineas: 1 },
    { id: 8, codigo: 'BETA_7', nombre: 'BETA 7', estado: 'ACTIVO' as const, numeroLineas: 1 },
    { id: 11, codigo: 'ADORNO', nombre: 'ADORNO', estado: 'ACTIVO' as const, numeroLineas: 1 },
    { id: 13, codigo: 'PREMONTADO', nombre: 'PREMONTADO', estado: 'ACTIVO' as const, numeroLineas: 1 },
  ];

  for (const d of departamentosData) {
    const res = await prisma.departamento.upsert({
      where: { codigo: d.codigo },
      update: {
        nombre: d.nombre,
        estado: d.estado,
        numeroLineas: d.numeroLineas,
        categoriaDepartamentoId: null,
      },
      create: {
        id: d.id,
        codigo: d.codigo,
        nombre: d.nombre,
        estado: d.estado,
        numeroLineas: d.numeroLineas,
        categoriaDepartamentoId: null,
      },
    });
    console.log(`✓ Departamento: [ID ${res.id}] Código: "${res.codigo}" | Nombre: "${res.nombre}" | Líneas: ${res.numeroLineas}`);
  }

  // D. RELACIONES DEPARTAMENTO-LÍNEA
  console.log('\n--- 4. Replicando Relaciones Departamento-Línea ---');
  const deptoLineasData = [
    { id: 1, departamentoId: 1, lineaId: 1, activo: true, orden: 0 },
    { id: 2, departamentoId: 2, lineaId: 1, activo: true, orden: 0 },
    { id: 3, departamentoId: 3, lineaId: 1, activo: true, orden: 0 },
    { id: 4, departamentoId: 5, lineaId: 1, activo: true, orden: 0 },
    { id: 5, departamentoId: 6, lineaId: 1, activo: true, orden: 0 },
    { id: 6, departamentoId: 7, lineaId: 1, activo: true, orden: 0 },
    { id: 7, departamentoId: 8, lineaId: 1, activo: true, orden: 0 },
    { id: 8, departamentoId: 4, lineaId: 1, activo: true, orden: 0 },
    { id: 9, departamentoId: 11, lineaId: 1, activo: true, orden: 0 },
    { id: 10, departamentoId: 13, lineaId: 1, activo: true, orden: 0 },
  ];

  for (const dl of deptoLineasData) {
    const res = await prisma.departamentoLinea.upsert({
      where: {
        unique_depto_linea: {
          departamentoId: dl.departamentoId,
          lineaId: dl.lineaId,
        },
      },
      update: {
        activo: dl.activo,
        orden: dl.orden,
      },
      create: {
        id: dl.id,
        departamentoId: dl.departamentoId,
        lineaId: dl.lineaId,
        activo: dl.activo,
        orden: dl.orden,
      },
    });
    console.log(`✓ Relación Depto-Línea: [ID ${res.id}] Depto ${res.departamentoId} -> Línea ${res.lineaId}`);
  }

  // F. ROLES
  console.log('\n--- 5. Verificando y Replicando Roles Base ---');
  const rolesProduccion = [
    { id: 1, codigo: 'SUPER_ADMIN', nombre: 'Super Administrador', descripcion: 'Acceso global al sistema', esSistema: true, estado: 'ACTIVO' as const },
    { id: 2, codigo: 'ADMIN', nombre: 'Administrador', descripcion: 'Administración operativa', esSistema: false, estado: 'ACTIVO' as const },
    { id: 3, codigo: 'USUARIO', nombre: 'Usuario General', descripcion: 'Usuario estándar', esSistema: false, estado: 'ACTIVO' as const },
  ];

  for (const r of rolesProduccion) {
    const res = await prisma.rol.upsert({
      where: { codigo: r.codigo },
      update: {
        nombre: r.nombre,
        descripcion: r.descripcion,
        esSistema: r.esSistema,
        estado: r.estado,
      },
      create: {
        id: r.id,
        codigo: r.codigo,
        nombre: r.nombre,
        descripcion: r.descripcion,
        esSistema: r.esSistema,
        estado: r.estado,
      },
    });
    console.log(`✓ Rol: [ID ${res.id}] Código: "${res.codigo}" | Nombre: "${res.nombre}" | esSistema: ${res.esSistema} | estado: ${res.estado}`);
  }

  // G. PERMISOS
  console.log('\n--- 6. Verificando los 21 Permisos Oficiales ---');
  const permisosData = [
    { id: 1, codigo: 'usuarios.consultar', nombre: 'Consultar usuarios', modulo: 'usuarios' },
    { id: 2, codigo: 'usuarios.crear', nombre: 'Crear usuarios', modulo: 'usuarios' },
    { id: 3, codigo: 'usuarios.editar', nombre: 'Editar usuarios', modulo: 'usuarios' },
    { id: 4, codigo: 'usuarios.desactivar', nombre: 'Desactivar usuarios', modulo: 'usuarios' },
    { id: 5, codigo: 'roles.gestionar', nombre: 'Gestionar roles y asignaciones', modulo: 'roles' },
    { id: 6, codigo: 'permisos.gestionar_excepciones', nombre: 'Gestionar excepciones de permisos', modulo: 'permisos' },
    { id: 7, codigo: 'departamentos.consultar', nombre: 'Consultar departamentos', modulo: 'departamentos' },
    { id: 8, codigo: 'departamentos.gestionar', nombre: 'Gestionar departamentos', modulo: 'departamentos' },
    { id: 9, codigo: 'terminales.consultar', nombre: 'Consultar terminales', modulo: 'terminales' },
    { id: 10, codigo: 'terminales.gestionar', nombre: 'Gestionar y vincular terminales', modulo: 'terminales' },
    { id: 11, codigo: 'defectos.capturar', nombre: 'Capturar defectos en terminal', modulo: 'defectos' },
    { id: 12, codigo: 'defectos.consultar_propios', nombre: 'Consultar defectos propios', modulo: 'defectos' },
    { id: 13, codigo: 'defectos.consultar_departamento', nombre: 'Consultar defectos del departamento', modulo: 'defectos' },
    { id: 14, codigo: 'defectos.corregir', nombre: 'Corregir registros de defectos', modulo: 'defectos' },
    { id: 15, codigo: 'defectos.autorizar_correccion', nombre: 'Autorizar corrección de defectos', modulo: 'defectos' },
    { id: 16, codigo: 'defectos.eliminar', nombre: 'Eliminar lógicamente defectos', modulo: 'defectos' },
    { id: 17, codigo: 'reportes.consultar', nombre: 'Consultar reportes de calidad', modulo: 'reportes' },
    { id: 18, codigo: 'auditoria.consultar', nombre: 'Consultar bitácora de auditoría', modulo: 'auditoria' },
    { id: 19, codigo: 'sincronizacion.consultar', nombre: 'Consultar estado de sincronización', modulo: 'sincronizacion' },
    { id: 20, codigo: 'sincronizacion.gestionar', nombre: 'Gestionar sincronización', modulo: 'sincronizacion' },
    { id: 21, codigo: 'sistema.configurar', nombre: 'Configuración global del sistema', modulo: 'sistema' },
  ];

  for (const p of permisosData) {
    const res = await prisma.permiso.upsert({
      where: { codigo: p.codigo },
      update: {
        nombre: p.nombre,
        modulo: p.modulo,
        estado: 'ACTIVO',
      },
      create: {
        id: p.id,
        codigo: p.codigo,
        nombre: p.nombre,
        modulo: p.modulo,
        estado: 'ACTIVO',
      },
    });
    console.log(`✓ Permiso: [ID ${res.id}] ${res.codigo} (${res.nombre})`);
  }

  // H. RELACIONES ROLES-PERMISOS (21 para SUPER_ADMIN)
  console.log('\n--- 7. Replicando Roles-Permisos (SUPER_ADMIN) ---');
  for (let permisoId = 1; permisoId <= 21; permisoId++) {
    await prisma.rolPermiso.upsert({
      where: {
        rolId_permisoId: {
          rolId: 1,
          permisoId,
        },
      },
      update: {
        estado: 'ACTIVO',
      },
      create: {
        rolId: 1,
        permisoId,
        estado: 'ACTIVO',
      },
    });
  }
  console.log('✓ 21 relaciones en roles_permisos asignadas a SUPER_ADMIN (ID 1).');

  // I. USUARIO ADMINISTRADOR
  console.log('\n--- 8. Verificando Usuario Administrador ---');
  const adminUser = await prisma.usuario.findFirst({
    where: { id: 1 },
    select: { id: true, usuario: true, nombre: true, rolId: true, estado: true },
  });
  console.log(`✓ Usuario Administrador verificado: [ID ${adminUser?.id}] "${adminUser?.usuario}" - Rol ${adminUser?.rolId} (${adminUser?.estado})`);

  console.log('\n=================================================================');
  console.log('Replicación completada con éxito.');
  console.log('=================================================================');
}

replicarConfiguracionProduccion()
  .catch((err) => {
    console.error('Error en replicación:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });

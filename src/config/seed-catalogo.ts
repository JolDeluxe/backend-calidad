import { prisma } from "./database";

export async function seedCatalogoBase() {
  console.log("🌱 Inicializando catálogo base de Sistema Web de Calidad MBC...");

  // 1. ROLES INICIALES (SUPER_ADMIN, ADMIN, COORD, INSPECTOR)
  const rolesDef = [
    {
      codigo: "SUPER_ADMIN",
      nombre: "Super Administrador",
      descripcion: "Configurador global y responsable del sistema",
      esSistema: true,
    },
    {
      codigo: "ADMIN",
      nombre: "Administrador",
      descripcion: "Administrador operativo del sistema",
      esSistema: true,
    },
    {
      codigo: "COORD",
      nombre: "Coordinador",
      descripcion: "Supervisión departamental y autorización de correcciones",
      esSistema: true,
    },
    {
      codigo: "INSPECTOR",
      nombre: "Inspector",
      descripcion: "Captura de defectos en departamentos autorizados",
      esSistema: true,
    },
  ];

  for (const rol of rolesDef) {
    await prisma.rol.upsert({
      where: { codigo: rol.codigo },
      update: {
        nombre: rol.nombre,
        descripcion: rol.descripcion,
        esSistema: rol.esSistema,
        estado: "ACTIVO",
      },
      create: {
        codigo: rol.codigo,
        nombre: rol.nombre,
        descripcion: rol.descripcion,
        esSistema: rol.esSistema,
        estado: "ACTIVO",
      },
    });
  }

  // 2. DEPARTAMENTOS OFICIALES DE MBC
  const departamentosDef = [
    { codigo: "CALIDAD", nombre: "Calidad" },
    { codigo: "CORTE", nombre: "Corte" },
    { codigo: "PRELIMINARES", nombre: "Preliminares" },
    { codigo: "BORDADO_LASER", nombre: "Bordado y Láser" },
    { codigo: "PESPUNTE", nombre: "Pespunte" },
    { codigo: "MONTADO", nombre: "Montado" },
    { codigo: "AVIOS", nombre: "Avíos" },
    { codigo: "ACABADO", nombre: "Acabado" },
    { codigo: "ADORNO", nombre: "Adorno" },
    { codigo: "DISENO", nombre: "Diseño" },
    { codigo: "MANTENIMIENTO", nombre: "Mantenimiento" },
  ];

  for (const depto of departamentosDef) {
    await prisma.departamento.upsert({
      where: { codigo: depto.codigo },
      update: { nombre: depto.nombre, estado: "ACTIVO" },
      create: { codigo: depto.codigo, nombre: depto.nombre, estado: "ACTIVO" },
    });
  }

  // 2.0 CATEGORÍA INICIAL: PRODUCCIÓN
  const catProduccion = await prisma.categoriaDepartamento.upsert({
    where: { nombre: "PRODUCCIÓN" },
    update: { activo: true },
    create: {
      nombre: "PRODUCCIÓN",
      descripcion: "Categoría de departamentos operativos de manufactura y producción",
      activo: true,
    },
  });

  // Asociar la categoría PRODUCCIÓN a los 8 departamentos iniciales si aún no tienen categoría
  const deptosProduccionCodigos = [
    "CORTE",
    "PRELIMINARES",
    "BORDADO_LASER",
    "PESPUNTE",
    "MONTADO",
    "AVIOS",
    "ACABADO",
    "ADORNO",
  ];

  for (const cod of deptosProduccionCodigos) {
    const d = await prisma.departamento.findUnique({ where: { codigo: cod } });
    if (d && !d.categoriaDepartamentoId) {
      await prisma.departamento.update({
        where: { id: d.id },
        data: { categoriaDepartamentoId: catProduccion.id },
      });
    }
  }

  // 2.1 ESTRUCTURA ORGANIZACIONAL: TIPO DE OPERACIÓN Y LÍNEAS INICIALES
  const tipoProduccion = await prisma.tipoOperacion.upsert({
    where: { codigo: "PRODUCCION" },
    update: { nombre: "Producción", estado: "ACTIVO" },
    create: {
      codigo: "PRODUCCION",
      nombre: "Producción",
      descripcion: "Operaciones de manufactura y producción de calzado y accesorios",
      estado: "ACTIVO",
    },
  });

  const lineaBota = await prisma.linea.upsert({
    where: {
      unique_tipo_linea_codigo: {
        tipoOperacionId: tipoProduccion.id,
        codigo: "BOTA",
      },
    },
    update: { nombre: "Bota", estado: "ACTIVO" },
    create: {
      tipoOperacionId: tipoProduccion.id,
      codigo: "BOTA",
      nombre: "Bota",
      descripcion: "Línea de producción de bota vaquera y urbana",
      estado: "ACTIVO",
    },
  });

  await prisma.linea.upsert({
    where: {
      unique_tipo_linea_codigo: {
        tipoOperacionId: tipoProduccion.id,
        codigo: "ACCESORIOS",
      },
    },
    update: { nombre: "Accesorios", estado: "ACTIVO" },
    create: {
      tipoOperacionId: tipoProduccion.id,
      codigo: "ACCESORIOS",
      nombre: "Accesorios",
      descripcion: "Línea de producción de marroquinería y accesorios",
      estado: "ACTIVO",
    },
  });

  // Asociar los 8 departamentos requeridos a la línea BOTA:
  // Corte, Preliminares, Bordado y Láser, Pespunte, Montado, Avíos, Acabado, Adorno
  const deptosBotaCodigos = [
    "CORTE",
    "PRELIMINARES",
    "BORDADO_LASER",
    "PESPUNTE",
    "MONTADO",
    "AVIOS",
    "ACABADO",
    "ADORNO",
  ];

  for (const cod of deptosBotaCodigos) {
    const d = await prisma.departamento.findUnique({ where: { codigo: cod } });
    if (d) {
      await prisma.departamentoLinea.upsert({
        where: {
          unique_depto_linea: {
            departamentoId: d.id,
            lineaId: lineaBota.id,
          },
        },
        update: { activo: true },
        create: {
          departamentoId: d.id,
          lineaId: lineaBota.id,
          activo: true,
        },
      });
    }
  }

  // 2.2 SECUENCIA DE CLAVES DE DEFECTO
  await prisma.secuenciaClaveDefecto.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      siguienteClave: 1836,
    },
  });

  // 2.3 DEFECTO INICIAL EJEMPLO: 1101 ("Cinta de refuerzo mal colocada", CRITICO)
  const superAdmin = await prisma.usuario.findFirst({ where: { usuario: "admin" } });
  const deptoCorte = await prisma.departamento.findFirst({ where: { codigo: "CORTE" } });
  if (superAdmin && deptoCorte) {
    const defecto1101 = await prisma.defecto.upsert({
      where: { clave: 1101 },
      update: {
        defecto: "Cinta de refuerzo mal colocada",
        clasificacion: "CRITICO",
        departamentoId: deptoCorte.id,
        activo: true,
      },
      create: {
        clave: 1101,
        defecto: "Cinta de refuerzo mal colocada",
        clasificacion: "CRITICO",
        departamentoId: deptoCorte.id,
        activo: true,
        creadoPor: superAdmin.id,
      },
    });

    // Asociaciones del defecto 1101:
    // Disponible: Corte, Preliminares, Bordado y Láser, Pespunte, Montado, Acabado, Adorno
    // No disponible: Avíos (activo: false)
    const asociacionesDef = [
      { codigo: "CORTE", activo: true },
      { codigo: "PRELIMINARES", activo: true },
      { codigo: "BORDADO_LASER", activo: true },
      { codigo: "PESPUNTE", activo: true },
      { codigo: "MONTADO", activo: true },
      { codigo: "AVIOS", activo: false },
      { codigo: "ACABADO", activo: true },
      { codigo: "ADORNO", activo: true },
    ];

    for (const asoc of asociacionesDef) {
      const dep = await prisma.departamento.findUnique({ where: { codigo: asoc.codigo } });
      if (dep) {
        await prisma.defectoDepartamento.upsert({
          where: {
            unique_defecto_departamento: {
              defectoId: defecto1101.id,
              departamentoId: dep.id,
            },
          },
          update: { activo: asoc.activo },
          create: {
            defectoId: defecto1101.id,
            departamentoId: dep.id,
            activo: asoc.activo,
            creadoPor: superAdmin.id,
          },
        });
      }
    }
  }

  // 3. CATÁLOGO INICIAL DE PERMISOS
  const permisosDef = [
    // Módulo Usuarios
    { codigo: "usuarios.consultar", nombre: "Consultar usuarios", modulo: "usuarios" },
    { codigo: "usuarios.crear", nombre: "Crear usuarios", modulo: "usuarios" },
    { codigo: "usuarios.editar", nombre: "Editar usuarios", modulo: "usuarios" },
    { codigo: "usuarios.desactivar", nombre: "Desactivar usuarios", modulo: "usuarios" },
    // Módulo Roles y Permisos
    { codigo: "roles.gestionar", nombre: "Gestionar roles y asignaciones", modulo: "roles" },
    { codigo: "permisos.gestionar_excepciones", nombre: "Gestionar excepciones de permisos", modulo: "permisos" },
    // Módulo Departamentos
    { codigo: "departamentos.consultar", nombre: "Consultar departamentos", modulo: "departamentos" },
    { codigo: "departamentos.gestionar", nombre: "Gestionar departamentos", modulo: "departamentos" },
    // Módulo Terminales
    { codigo: "terminales.consultar", nombre: "Consultar terminales", modulo: "terminales" },
    { codigo: "terminales.gestionar", nombre: "Gestionar y vincular terminales", modulo: "terminales" },
    // Módulo Defectos (Operativo de Calidad)
    { codigo: "defectos.capturar", nombre: "Capturar defectos en terminal", modulo: "defectos" },
    { codigo: "defectos.consultar_propios", nombre: "Consultar defectos propios", modulo: "defectos" },
    { codigo: "defectos.consultar_departamento", nombre: "Consultar defectos del departamento", modulo: "defectos" },
    { codigo: "defectos.corregir", nombre: "Corregir registros de defectos", modulo: "defectos" },
    { codigo: "defectos.autorizar_correccion", nombre: "Autorizar corrección de defectos", modulo: "defectos" },
    { codigo: "defectos.eliminar", nombre: "Eliminar lógicamente defectos", modulo: "defectos" },
    // Módulo Reportes y Auditoría
    { codigo: "reportes.consultar", nombre: "Consultar reportes de calidad", modulo: "reportes" },
    { codigo: "auditoria.consultar", nombre: "Consultar bitácora de auditoría", modulo: "auditoria" },
    // Módulo Sincronización y Configuración Global
    { codigo: "sincronizacion.consultar", nombre: "Consultar estado de sincronización", modulo: "sincronizacion" },
    { codigo: "sincronizacion.gestionar", nombre: "Gestionar sincronización", modulo: "sincronizacion" },
    { codigo: "sistema.configurar", nombre: "Configuración global del sistema", modulo: "sistema" },
  ];

  for (const perm of permisosDef) {
    await prisma.permiso.upsert({
      where: { codigo: perm.codigo },
      update: { nombre: perm.nombre, modulo: perm.modulo, estado: "ACTIVO" },
      create: { codigo: perm.codigo, nombre: perm.nombre, modulo: perm.modulo, estado: "ACTIVO" },
    });
  }

  // 4. ASIGNACIONES DE PERMISOS POR ROL
  const allPermisos = await prisma.permiso.findMany();
  const permMap = new Map(allPermisos.map((p) => [p.codigo, p.id]));

  const superAdminRol = await prisma.rol.findUnique({ where: { codigo: "SUPER_ADMIN" } });
  const adminRol = await prisma.rol.findUnique({ where: { codigo: "ADMIN" } });
  const coordRol = await prisma.rol.findUnique({ where: { codigo: "COORD" } });
  const inspectorRol = await prisma.rol.findUnique({ where: { codigo: "INSPECTOR" } });

  const assignPermsToRole = async (rolId: number, codigos: string[]) => {
    for (const codigo of codigos) {
      const permisoId = permMap.get(codigo);
      if (permisoId) {
        await prisma.rolPermiso.upsert({
          where: { rolId_permisoId: { rolId, permisoId } },
          update: { estado: "ACTIVO" },
          create: { rolId, permisoId, estado: "ACTIVO" },
        });
      }
    }
  };

  // SUPER_ADMIN tiene todos los permisos
  if (superAdminRol) {
    await assignPermsToRole(superAdminRol.id, permisosDef.map((p) => p.codigo));
  }

  // ADMIN: módulos operativos, gestión de usuarios, departamentos y reportes (no gestión de terminales ni sistema.configurar)
  // Conforme a las reglas de seguridad: Únicamente SUPER_ADMIN puede gestionar/vincular terminales
  if (adminRol) {
    await assignPermsToRole(adminRol.id, [
      "usuarios.consultar", "usuarios.crear", "usuarios.editar", "usuarios.desactivar",
      "departamentos.consultar", "terminales.consultar",
      "defectos.consultar_departamento", "defectos.corregir", "reportes.consultar", "auditoria.consultar",
    ]);
  }

  // COORD: supervisión de departamento, defectos, autorización de correcciones y reportes
  if (coordRol) {
    await assignPermsToRole(coordRol.id, [
      "departamentos.consultar",
      "defectos.consultar_departamento",
      "defectos.corregir",
      "defectos.autorizar_correccion",
      "reportes.consultar",
    ]);
  }

  // INSPECTOR: captura en terminal, consulta de registros propios/terminal y eliminación lógica
  if (inspectorRol) {
    await assignPermsToRole(inspectorRol.id, [
      "defectos.capturar",
      "defectos.consultar_propios",
      "defectos.eliminar",
    ]);
  }

  // 5. ASIGNAR DEPARTAMENTO 'CALIDAD' AL USUARIO 'admin'
  const adminUser = await prisma.usuario.findFirst({ where: { usuario: "admin" } });
  const calidadDepto = await prisma.departamento.findUnique({ where: { codigo: "CALIDAD" } });

  if (adminUser && calidadDepto) {
    await prisma.usuarioDepartamento.upsert({
      where: {
        usuarioId_departamentoId: {
          usuarioId: adminUser.id,
          departamentoId: calidadDepto.id,
        },
      },
      update: { estado: "ACTIVO" },
      create: {
        usuarioId: adminUser.id,
        departamentoId: calidadDepto.id,
        estado: "ACTIVO",
      },
    });
  }

  console.log("✅ Catálogo base, roles, permisos y departamentos inicializados exitosamente.");
}

// Ejecutar si se llama directamente
if (import.meta.main) {
  seedCatalogoBase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Error en seedCatalogoBase:", err);
      process.exit(1);
    });
}

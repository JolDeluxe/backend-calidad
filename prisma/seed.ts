import { prisma } from "../src/config/database";
import { securityService } from "../src/modules/auth/services/security.service";

/**
 * Catálogo canónico oficial de permisos del Sistema Web de Calidad MBC.
 * Recuperado exactamente de las definiciones arquitectónicas oficiales del proyecto.
 */
export const PERMISOS_SISTEMA_OFICIALES = [
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

async function main() {
  console.log("==================================================");
  console.log("Iniciando Seed Oficial de Seguridad: Calidad MBC");
  console.log("==================================================");

  // 1. Validar variables de entorno obligatorias
  const adminUsuario = process.env.SUPER_ADMIN_USUARIO?.trim();
  const adminNombre = process.env.SUPER_ADMIN_NOMBRE?.trim();
  const adminPassword = process.env.SUPER_ADMIN_PASSWORD?.trim();

  if (!adminUsuario) {
    throw new Error(
      "❌ Variable de entorno SUPER_ADMIN_USUARIO no configurada o vacía. No se puede continuar con el seed."
    );
  }

  if (!adminNombre) {
    throw new Error(
      "❌ Variable de entorno SUPER_ADMIN_NOMBRE no configurada o vacía. No se puede continuar con el seed."
    );
  }

  if (!adminPassword) {
    throw new Error(
      "❌ Variable de entorno SUPER_ADMIN_PASSWORD no configurada o vacía. No se permiten contraseñas predeterminadas."
    );
  }

  // 2. Garantizar existencia y protección del rol SUPER_ADMIN de forma idempotente
  // Si ya existe (incluso con es_sistema = 0), se actualiza exclusivamente esSistema a true sin alterar otros campos.
  const rolSuperAdmin = await prisma.rol.upsert({
    where: { codigo: "SUPER_ADMIN" },
    update: {
      esSistema: true,
      estado: "ACTIVO",
    },
    create: {
      codigo: "SUPER_ADMIN",
      nombre: "Super Administrador",
      descripcion: "Acceso global al sistema",
      esSistema: true,
      estado: "ACTIVO",
    },
  });

  console.log(`✓ Rol SUPER_ADMIN verificado y protegido (ID: ${rolSuperAdmin.id}, esSistema: true)`);

  // 3. Inicializar catálogo canónico de permisos de forma idempotente
  for (const perm of PERMISOS_SISTEMA_OFICIALES) {
    await prisma.permiso.upsert({
      where: { codigo: perm.codigo },
      update: {
        nombre: perm.nombre,
        modulo: perm.modulo,
        estado: "ACTIVO",
      },
      create: {
        codigo: perm.codigo,
        nombre: perm.nombre,
        modulo: perm.modulo,
        estado: "ACTIVO",
      },
    });
  }
  console.log(`✓ Catálogo oficial de permisos verificado (${PERMISOS_SISTEMA_OFICIALES.length} permisos)`);

  // 4. Asignar todos los permisos oficiales al rol SUPER_ADMIN en roles_permisos
  const permisosEnDb = await prisma.permiso.findMany({
    where: {
      codigo: { in: PERMISOS_SISTEMA_OFICIALES.map((p) => p.codigo) },
    },
  });

  for (const perm of permisosEnDb) {
    await prisma.rolPermiso.upsert({
      where: {
        rolId_permisoId: {
          rolId: rolSuperAdmin.id,
          permisoId: perm.id,
        },
      },
      update: {
        estado: "ACTIVO",
      },
      create: {
        rolId: rolSuperAdmin.id,
        permisoId: perm.id,
        estado: "ACTIVO",
      },
    });
  }
  console.log(`✓ Permisos oficiales asignados al rol SUPER_ADMIN en roles_permisos (${permisosEnDb.length} relaciones)`);

  // 5. Verificar si el usuario ya existe para validar su rol y no sobrescribir credenciales ni estado
  const usuarioExistente = await prisma.usuario.findUnique({
    where: { usuario: adminUsuario },
    include: { rol: true },
  });

  if (usuarioExistente) {
    if (usuarioExistente.rolId !== rolSuperAdmin.id && usuarioExistente.rol?.codigo !== "SUPER_ADMIN") {
      throw new Error(
        `❌ El usuario '${adminUsuario}' ya existe en el sistema pero tiene asignado el rol '${usuarioExistente.rol?.codigo || usuarioExistente.rolId}', no SUPER_ADMIN. Deteniendo seed para prevenir inconsistencias de privilegios.`
      );
    }

    console.log(
      `ℹ El usuario SUPER_ADMIN '${adminUsuario}' ya existe en el sistema con el rol correcto (ID: ${usuarioExistente.id}, Estado: ${usuarioExistente.estado}).`
    );
    console.log("  No se modificará contraseña, nombre, estado ni rol existente.");
  } else {
    // 6. Crear nuevo usuario SUPER_ADMIN con hash institucional seguro
    const passwordHash = securityService.hashPassword(adminPassword);

    const nuevoUsuario = await prisma.usuario.create({
      data: {
        usuario: adminUsuario,
        nombre: adminNombre,
        passwordHash,
        rolId: rolSuperAdmin.id,
        estado: "ACTIVO",
      },
    });

    console.log(`✓ Usuario SUPER_ADMIN '${nuevoUsuario.usuario}' creado exitosamente (ID: ${nuevoUsuario.id}).`);
  }

  console.log("==================================================");
  console.log("Seed oficial de seguridad completado exitosamente.");
  console.log("==================================================");
}

main()
  .catch((e) => {
    console.error("❌ Error en seed:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

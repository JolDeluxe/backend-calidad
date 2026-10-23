import { prisma } from "../src/config/database";
import { securityService } from "../src/modules/auth/services/security.service";

async function main() {
  console.log("==================================================");
  console.log("Iniciando Seed Oficial de Autenticación: 10_proyecto_calidad");
  console.log("==================================================");

  // 1. Roles Base
  const rolSuperAdmin = await prisma.rol.upsert({
    where: { codigo: "SUPER_ADMIN" },
    update: { nombre: "Super Administrador", descripcion: "Acceso global al sistema", estado: "ACTIVO" },
    create: { codigo: "SUPER_ADMIN", nombre: "Super Administrador", descripcion: "Acceso global al sistema", estado: "ACTIVO" },
  });

  await prisma.rol.upsert({
    where: { codigo: "ADMIN" },
    update: { nombre: "Administrador", descripcion: "Administración operativa", estado: "ACTIVO" },
    create: { codigo: "ADMIN", nombre: "Administrador", descripcion: "Administración operativa", estado: "ACTIVO" },
  });

  await prisma.rol.upsert({
    where: { codigo: "USUARIO" },
    update: { nombre: "Usuario General", descripcion: "Usuario estándar", estado: "ACTIVO" },
    create: { codigo: "USUARIO", nombre: "Usuario General", descripcion: "Usuario estándar", estado: "ACTIVO" },
  });

  // 2. Usuario Super Admin Inicial desde variables de entorno
  const adminUsuario = process.env.SUPER_ADMIN_USUARIO || "admin";
  const adminNombre = process.env.SUPER_ADMIN_NOMBRE || "Super Administrador";
  const adminPassword = process.env.SUPER_ADMIN_PASSWORD || "Deadmau6";
  const adminPasswordHash = securityService.hashPassword(adminPassword);

  const usuario = await prisma.usuario.upsert({
    where: { usuario: adminUsuario },
    update: {
      nombre: adminNombre,
      passwordHash: adminPasswordHash,
      rolId: rolSuperAdmin.id,
      estado: "ACTIVO",
    },
    create: {
      usuario: adminUsuario,
      nombre: adminNombre,
      passwordHash: adminPasswordHash,
      rolId: rolSuperAdmin.id,
      estado: "ACTIVO",
    },
  });

  console.log("   -> Usuario inicial configurado: " + usuario.usuario);
  console.log("Seed completado exitosamente!");
}

main()
  .catch((e) => {
    console.error("❌ Error en seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
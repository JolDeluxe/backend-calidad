import { describe, it, expect, afterAll } from "bun:test";
import { prisma } from "../src/config/database";
import { permissionsService } from "../src/modules/auth/services/permissions.service";
import { PERMISOS_SISTEMA_OFICIALES } from "../prisma/seed";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe("Seed Oficial de Seguridad — Pruebas de Idempotencia y Permisos SUPER_ADMIN", () => {
  const testUser = `test_admin_seed_${Date.now()}`;
  const testPass = "TestPasswordSecure123!";
  const testName = "Admin de Pruebas Seed";

  const runSeedWithEnv = (customEnv: Record<string, string>) => {
    return spawnSync(
      process.execPath,
      ["run", "prisma/seed.ts"],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          ...customEnv,
        },
        encoding: "utf-8",
        timeout: 15000,
      }
    );
  };

  afterAll(async () => {
    // Limpieza de datos de prueba creados
    await prisma.usuario.deleteMany({
      where: { usuario: testUser },
    });
  });

  it("1. Debe fallar si faltan variables de entorno requeridas", () => {
    const res = runSeedWithEnv({
      SUPER_ADMIN_USUARIO: "",
      SUPER_ADMIN_PASSWORD: "",
      SUPER_ADMIN_NOMBRE: "",
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toContain("SUPER_ADMIN_USUARIO no configurada");
  }, 15000);

  it("2. Ejecución exitosa del seed: crea rol con es_sistema=1, todos los permisos y asignación a SUPER_ADMIN", () => {
    const res = runSeedWithEnv({
      SUPER_ADMIN_USUARIO: testUser,
      SUPER_ADMIN_NOMBRE: testName,
      SUPER_ADMIN_PASSWORD: testPass,
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Seed oficial de seguridad completado exitosamente");
  }, 15000);

  it("3. Verificación en base de datos: es_sistema=true, 21 permisos y asignaciones a SUPER_ADMIN", async () => {
    const rol = await prisma.rol.findUnique({
      where: { codigo: "SUPER_ADMIN" },
      include: {
        permisos: {
          include: { permiso: true },
        },
      },
    });

    expect(rol).not.toBeNull();
    expect(rol!.esSistema).toBe(true);

    const permisosTotales = await prisma.permiso.count({
      where: { estado: "ACTIVO" },
    });
    expect(permisosTotales).toBeGreaterThanOrEqual(PERMISOS_SISTEMA_OFICIALES.length);

    // Verificar que SUPER_ADMIN tenga los 21 permisos oficiales en roles_permisos
    const permisosAsignadosCodigos = rol!.permisos.map((p) => p.permiso.codigo);
    for (const perm of PERMISOS_SISTEMA_OFICIALES) {
      expect(permisosAsignadosCodigos).toContain(perm.codigo);
    }

    // Verificar usuario creado
    const userDb = await prisma.usuario.findUnique({
      where: { usuario: testUser },
    });
    expect(userDb).not.toBeNull();
    expect(userDb!.rolId).toBe(rol!.id);
  }, 15000);

  it("4. PermissionsService: SUPER_ADMIN resuelve correctamente todos los permisos vía hasPermission", async () => {
    const userDb = await prisma.usuario.findUnique({
      where: { usuario: testUser },
    });
    expect(userDb).not.toBeNull();

    for (const perm of PERMISOS_SISTEMA_OFICIALES) {
      const tiene = await permissionsService.hasPermission(userDb!.id, perm.codigo);
      expect(tiene).toBe(true);
    }
  }, 15000);

  it("5. Idempotencia: Una segunda ejecución no duplica registros ni altera contraseña", async () => {
    const userAntes = await prisma.usuario.findUnique({
      where: { usuario: testUser },
    });
    const hashAntes = userAntes!.passwordHash;

    const res = runSeedWithEnv({
      SUPER_ADMIN_USUARIO: testUser,
      SUPER_ADMIN_NOMBRE: testName,
      SUPER_ADMIN_PASSWORD: "DifferentPasswordAttempt",
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("ya existe en el sistema con el rol correcto");

    const userDespues = await prisma.usuario.findUnique({
      where: { usuario: testUser },
    });

    // La contraseña existente no debe haberse sobrescrito
    expect(userDespues!.passwordHash).toBe(hashAntes);
  }, 15000);

  it("6. Validación de seguridad: Si el usuario existe con un rol diferente, el seed debe abortar", async () => {
    let rolAdmin = await prisma.rol.findUnique({ where: { codigo: "ADMIN" } });
    if (!rolAdmin) {
      rolAdmin = await prisma.rol.create({
        data: {
          codigo: "ADMIN",
          nombre: "Administrador",
          estado: "ACTIVO",
        },
      });
    }

    const testConflictUser = `conflict_user_${Date.now()}`;
    await prisma.usuario.create({
      data: {
        usuario: testConflictUser,
        nombre: "Usuario Conflicto",
        passwordHash: "dummyHash",
        rolId: rolAdmin.id,
        estado: "ACTIVO",
      },
    });

    const res = runSeedWithEnv({
      SUPER_ADMIN_USUARIO: testConflictUser,
      SUPER_ADMIN_NOMBRE: "Super Admin",
      SUPER_ADMIN_PASSWORD: "Password123!",
    });

    // Debe salir con código de error y advertir que tiene un rol distinto
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toContain("no SUPER_ADMIN. Deteniendo seed");

    // Limpieza
    await prisma.usuario.delete({ where: { usuario: testConflictUser } });
  }, 15000);
});

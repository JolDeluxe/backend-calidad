import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../src/config/database";
import { permissionsService } from "../src/modules/auth/services/permissions.service";
import { terminalsService } from "../src/modules/auth/services/terminals.service";
import { UnauthorizedError, ForbiddenError } from "../src/utils/errors";

describe("Modelo Definitivo de Roles, Permisos, Departamentos, Terminales y Auditoría", () => {
  let adminId: number;
  let inspectorUserId: number;
  let calidadDeptoId: number;
  let corteDeptoId: number;
  let inspectorRoleId: number;
  let testTerminalId: number;
  let testCredencialPlana: string;

  beforeAll(async () => {
    // 1. Obtener usuario admin existente y departamentos
    const admin = await prisma.usuario.findFirst({ where: { usuario: "admin" } });
    if (!admin) throw new Error("admin no existe");
    adminId = admin.id;

    const calidad = await prisma.departamento.findUnique({ where: { codigo: "CALIDAD" } });
    const corte = await prisma.departamento.findUnique({ where: { codigo: "CORTE" } });
    const rolInspector = await prisma.rol.findUnique({ where: { codigo: "INSPECTOR" } });

    if (!calidad || !corte || !rolInspector) {
      throw new Error("Catálogo base incompleto");
    }

    calidadDeptoId = calidad.id;
    corteDeptoId = corte.id;
    inspectorRoleId = rolInspector.id;

    // 2. Crear un usuario de prueba con rol INSPECTOR
    const inspectorUser = await prisma.usuario.upsert({
      where: { usuario: "inspector_test" },
      update: { estado: "ACTIVO", rolId: inspectorRoleId },
      create: {
        usuario: "inspector_test",
        nombre: "Inspector de Prueba",
        passwordHash: "dummy:hash",
        rolId: inspectorRoleId,
        estado: "ACTIVO",
      },
    });
    inspectorUserId = inspectorUser.id;

    // Asignar al departamento CALIDAD únicamente
    await prisma.usuarioDepartamento.upsert({
      where: {
        usuarioId_departamentoId: {
          usuarioId: inspectorUserId,
          departamentoId: calidadDeptoId,
        },
      },
      update: { estado: "ACTIVO" },
      create: {
        usuarioId: inspectorUserId,
        departamentoId: calidadDeptoId,
        estado: "ACTIVO",
      },
    });
  });

  // A. Resolución de permisos por rol
  it("A. El inspector hereda permisos de su rol (defectos.capturar)", async () => {
    const efectivos = await permissionsService.getPermisosEfectivos(inspectorUserId);
    expect(efectivos.permisos).toContain("defectos.capturar");
    expect(efectivos.permisos).toContain("defectos.consultar_propios");
    expect(efectivos.permisos).not.toContain("usuarios.crear"); // No tiene permisos de admin
  });

  // B. Excepciones de permisos individuales: CONCEDER y DENEGAR
  it("B. Excepciones individuales: DENEGAR prevalece sobre permiso heredado", async () => {
    const permisoCapturar = await prisma.permiso.findUnique({ where: { codigo: "defectos.capturar" } });
    expect(permisoCapturar).not.toBeNull();

    // 1. Agregar excepción DENEGAR
    await prisma.usuarioPermiso.upsert({
      where: {
        unique_usuario_permiso: {
          usuarioId: inspectorUserId,
          permisoId: permisoCapturar!.id,
        },
      },
      update: { accion: "DENEGAR", motivo: "Sanción temporal" },
      create: {
        usuarioId: inspectorUserId,
        permisoId: permisoCapturar!.id,
        accion: "DENEGAR",
        motivo: "Sanción temporal",
      },
    });

    const tienePermisoDenegado = await permissionsService.hasPermission(inspectorUserId, "defectos.capturar");
    expect(tienePermisoDenegado).toBe(false);

    // 2. Cambiar excepción a CONCEDER un permiso extra (ej. reportes.consultar)
    const permisoReportes = await prisma.permiso.findUnique({ where: { codigo: "reportes.consultar" } });
    await prisma.usuarioPermiso.upsert({
      where: {
        unique_usuario_permiso: {
          usuarioId: inspectorUserId,
          permisoId: permisoReportes!.id,
        },
      },
      update: { accion: "CONCEDER", motivo: "Habilitación especial" },
      create: {
        usuarioId: inspectorUserId,
        permisoId: permisoReportes!.id,
        accion: "CONCEDER",
        motivo: "Habilitación especial",
      },
    });

    const tienePermisoConcedido = await permissionsService.hasPermission(inspectorUserId, "reportes.consultar");
    expect(tienePermisoConcedido).toBe(true);
  });

  // C. Alcance departamental
  it("C. Alcance departamental: el usuario solo tiene alcance en departamentos asignados", async () => {
    const tieneAlcanceCalidad = await permissionsService.hasDepartmentScope(inspectorUserId, calidadDeptoId);
    expect(tieneAlcanceCalidad).toBe(true);

    const tieneAlcanceCorte = await permissionsService.hasDepartmentScope(inspectorUserId, corteDeptoId);
    expect(tieneAlcanceCorte).toBe(false);

    // SUPER_ADMIN tiene alcance global
    const adminAlcanceCorte = await permissionsService.hasDepartmentScope(adminId, corteDeptoId);
    expect(adminAlcanceCorte).toBe(true);
  });

  // D. Terminales vinculadas al navegador
  it("D. Terminales: creación con hash, validación por credencial y revocación", async () => {
    // 1. Crear terminal para CALIDAD
    const creada = await terminalsService.createTerminal({
      nombre: "TEST-TERM-01",
      departamentoId: calidadDeptoId,
      usuarioAuditId: adminId,
    });

    expect(creada.terminal.nombre).toBe("TEST-TERM-01");
    expect(creada.credencial).toBeDefined();
    testTerminalId = creada.terminal.id;
    testCredencialPlana = creada.credencial;

    // Verificar que en MySQL se almacenó el hash, nunca la credencial plana
    const terminalDb = await prisma.terminal.findUnique({ where: { id: testTerminalId } });
    expect(terminalDb?.credencialHash).not.toBe(testCredencialPlana);
    expect(terminalDb?.credencialHash.length).toBe(64); // SHA-256 hex

    // 2. Validar terminal exitosamente
    const terminalValidada = await terminalsService.validateTerminal(testCredencialPlana);
    expect(terminalValidada.id).toBe(testTerminalId);
    expect(terminalValidada.departamentoId).toBe(calidadDeptoId);

    // 3. Auditoría registrada
    const auditoriaCreacion = await prisma.registroAuditoria.findFirst({
      where: { accion: "TERMINAL_CREADA", terminalId: testTerminalId },
    });
    expect(auditoriaCreacion).not.toBeNull();

    // 4. Revocar terminal
    await terminalsService.revokeTerminal(testTerminalId, "Robo o desvinculación", adminId);

    // Validar rechazo tras revocación
    await expect(terminalsService.validateTerminal(testCredencialPlana)).rejects.toThrow(UnauthorizedError);
  });

  afterAll(async () => {
    // Limpieza de datos de prueba
    if (testTerminalId) {
      await prisma.registroAuditoria.deleteMany({ where: { terminalId: testTerminalId } });
      await prisma.terminal.deleteMany({ where: { id: testTerminalId } });
    }
    if (inspectorUserId) {
      await prisma.usuarioPermiso.deleteMany({ where: { usuarioId: inspectorUserId } });
      await prisma.usuarioDepartamento.deleteMany({ where: { usuarioId: inspectorUserId } });
      await prisma.usuario.deleteMany({ where: { id: inspectorUserId } });
    }
  });
});

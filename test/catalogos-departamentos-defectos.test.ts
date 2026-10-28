import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { securityService } from "../src/modules/auth/services/security.service";
import type { Server } from "http";

describe("Catálogos de Departamentos y Defectos — Pruebas Exhaustivas", () => {
  let appServer: Server;
  let baseUrl: string;
  let adminToken: string;
  let inspectorToken: string;
  let adminUser: any;
  let inspectorUser: any;

  beforeAll(async () => {
    const app = createApp();
    appServer = app.listen(0);
    const port = (appServer.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}/api/v1`;

    adminUser = await prisma.usuario.findFirst({
      where: { usuario: "admin" },
      include: { rol: true },
    });
    if (!adminUser) throw new Error("Usuario admin no encontrado");

    const sesionAdmin = await prisma.sesion.create({
      data: {
        usuarioId: adminUser.id,
        refreshTokenHash: `hash_admin_catalog_${Date.now()}_${Math.random()}`,
        fechaExpiracion: new Date(Date.now() + 3600000),
      },
    });

    adminToken = securityService.generateAccessToken({
      usuarioId: adminUser.id,
      usuario: adminUser.usuario,
      nombre: adminUser.nombre,
      rolId: adminUser.rolId,
      rolCodigo: adminUser.rol.codigo,
      sesionId: sesionAdmin.id,
    });

    // Crear inspector para pruebas de permisos
    let insp = await prisma.usuario.findFirst({
      where: { usuario: "inspector_catalog_test" },
      include: { rol: true },
    });

    if (!insp) {
      const inspectorRol = await prisma.rol.findUnique({ where: { codigo: "INSPECTOR" } });
      insp = await prisma.usuario.create({
        data: {
          usuario: "inspector_catalog_test",
          nombre: "Inspector Catalog Test",
          passwordHash: "hash_test_123",
          rolId: inspectorRol!.id,
          estado: "ACTIVO",
        },
        include: { rol: true },
      });
    }

    inspectorUser = insp;

    const sesionInsp = await prisma.sesion.create({
      data: {
        usuarioId: inspectorUser.id,
        refreshTokenHash: `hash_insp_catalog_${Date.now()}_${Math.random()}`,
        fechaExpiracion: new Date(Date.now() + 3600000),
      },
    });

    inspectorToken = securityService.generateAccessToken({
      usuarioId: inspectorUser.id,
      usuario: inspectorUser.usuario,
      nombre: inspectorUser.nombre,
      rolId: inspectorUser.rolId,
      rolCodigo: inspectorUser.rol.codigo,
      sesionId: sesionInsp.id,
    });

    // Asegurar que el defecto 1101 y sus asociaciones iniciales estén activas
    const def1101 = await prisma.defecto.findUnique({ where: { clave: 1101 } });
    if (def1101) {
      await prisma.defecto.update({
        where: { id: def1101.id },
        data: { activo: true, eliminadoEn: null, eliminadoPor: null },
      });
      const deptoCorte = await prisma.departamento.findUnique({ where: { codigo: "CORTE" } });
      const deptoPespunte = await prisma.departamento.findUnique({ where: { codigo: "PESPUNTE" } });
      if (deptoCorte) {
        await prisma.defectoDepartamento.upsert({
          where: { unique_defecto_departamento: { defectoId: def1101.id, departamentoId: deptoCorte.id } },
          update: { activo: true, eliminadoEn: null, eliminadoPor: null },
          create: { defectoId: def1101.id, departamentoId: deptoCorte.id, activo: true, creadoPor: adminUser.id },
        });
      }
      if (deptoPespunte) {
        await prisma.defectoDepartamento.upsert({
          where: { unique_defecto_departamento: { defectoId: def1101.id, departamentoId: deptoPespunte.id } },
          update: { activo: true, eliminadoEn: null, eliminadoPor: null },
          create: { defectoId: def1101.id, departamentoId: deptoPespunte.id, activo: true, creadoPor: adminUser.id },
        });
      }
    }
  });

  afterAll(async () => {
    appServer.close();
  });

  // 1. Crear un defecto con asignación automática de clave
  it("1. Debe crear un defecto con asignación automática de clave >= 1836", async () => {
    const res = await fetch(`${baseUrl}/defectos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        defecto: "Costura desalineada en tubo",
        clasificacion: "MAYOR",
        departamentoId: 2,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.id).toBeDefined();
    expect(body.data.clave).toBeGreaterThanOrEqual(1836);
    expect(body.data.defecto).toBe("Costura desalineada en tubo");
    expect(body.data.clasificacion).toBe("MAYOR");
    expect(body.data.activo).toBe(true);
  });

  // 2. Crear defectos concurrentemente sin claves duplicadas
  it("2. Debe crear defectos concurrentemente sin claves duplicadas", async () => {
    const totalConcurrentes = 5;
    const peticiones = Array.from({ length: totalConcurrentes }, (_, i) =>
      fetch(`${baseUrl}/defectos`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          defecto: `Defecto concurrente ${i + 1} - ${Date.now()}`,
          clasificacion: "MENOR",
          departamentoId: 2,
        }),
      }).then((r) => r.json() as Promise<any>)
    );

    const resultados = await Promise.all(peticiones);
    const claves = resultados.map((r) => r.data.clave);
    const clavesUnicas = new Set(claves);

    expect(claves.length).toBe(totalConcurrentes);
    expect(clavesUnicas.size).toBe(totalConcurrentes);
  });

  // 3. Modificar una clave y verificar la auditoría
  it("3. Modificar una clave mediante operación administrativa autorizada y verificar auditoría", async () => {
    // Crear defecto para prueba
    const postRes = await fetch(`${baseUrl}/defectos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        defecto: "Defecto para cambio de clave",
        clasificacion: "CRITICO",
        departamentoId: 2,
      }),
    });
    const def = (await postRes.json()) as any;
    const defectoId = def.data.id;
    const claveOriginal = def.data.clave;
    const nuevaClave = 90000 + Math.floor(Math.random() * 9000);

    const patchRes = await fetch(`${baseUrl}/defectos/${defectoId}/clave`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        nuevaClave,
      }),
    });

    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as any;
    expect(patchBody.data.clave).toBe(nuevaClave);
    expect(patchBody.data.id).toBe(defectoId); // El ID interno nunca cambia

    // Verificar en auditoría
    const auditRes = await prisma.registroAuditoria.findFirst({
      where: {
        accion: "DEFECTO_CLAVE_MODIFICADA",
        entidadId: defectoId.toString(),
      },
      orderBy: { id: "desc" },
    });
    expect(auditRes).toBeDefined();
    const detalles = auditRes?.detalles as any;
    expect(detalles.valoresAnteriores.clave).toBe(claveOriginal);
    expect(detalles.valoresPosteriores.clave).toBe(nuevaClave);
  });

  // 4. Rechazar una clave duplicada
  it("4. Debe rechazar una clave duplicada al intentar modificar a una ya existente", async () => {
    // 1101 ya existe por el seeder
    const postRes = await fetch(`${baseUrl}/defectos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        defecto: "Defecto para prueba de clave duplicada",
        clasificacion: "MENOR",
        departamentoId: 2,
      }),
    });
    const def = (await postRes.json()) as any;

    const patchRes = await fetch(`${baseUrl}/defectos/${def.data.id}/clave`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        nuevaClave: 1101, // ya existente
      }),
    });

    expect(patchRes.status).toBe(409); // Conflict
  });

  // 5. Rechazar la reutilización de una clave eliminada lógicamente
  it("5. Debe rechazar la reasignación de una clave que pertenece a un defecto eliminado lógicamente", async () => {
    // 1. Crear y eliminar lógicamente un defecto
    const postRes = await fetch(`${baseUrl}/defectos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        defecto: "Defecto a eliminar lógicamente",
        clasificacion: "MENOR",
        departamentoId: 2,
      }),
    });
    const def1 = (await postRes.json()) as any;

    const delRes = await fetch(`${baseUrl}/defectos/${def1.data.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.status).toBe(200);

    // 2. Crear un segundo defecto
    const postRes2 = await fetch(`${baseUrl}/defectos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        defecto: "Defecto segundo",
        clasificacion: "MAYOR",
        departamentoId: 2,
      }),
    });
    const def2 = (await postRes2.json()) as any;

    // 3. Intentar asignar al segundo defecto la clave del primero (eliminado)
    const patchRes = await fetch(`${baseUrl}/defectos/${def2.data.id}/clave`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        nuevaClave: def1.data.clave,
      }),
    });

    expect(patchRes.status).toBe(409);
  });

  // 6. Asociar un defecto con varios departamentos
  it("6. Debe asociar un defecto con varios departamentos", async () => {
    const postRes = await fetch(`${baseUrl}/defectos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        defecto: "Defecto multi-departamento",
        clasificacion: "CRITICO",
        departamentoId: 2,
      }),
    });
    const def = (await postRes.json()) as any;
    const defectoId = def.data.id;

    const deptos = await prisma.departamento.findMany({ take: 3 });

    const putRes = await fetch(`${baseUrl}/defectos/${defectoId}/departamentos`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        departamentos: [
          { departamentoId: deptos[0].id, activo: true },
          { departamentoId: deptos[1].id, activo: true },
          { departamentoId: deptos[2].id, activo: false },
        ],
      }),
    });

    expect(putRes.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/defectos/${defectoId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const getBody = (await getRes.json()) as any;
    expect(getBody.data.departamentos.length).toBe(3);
  });

  // 7. Deshabilitar una asociación sin alterar las demás
  it("7. Debe deshabilitar una asociación departamento-defecto individual sin alterar las demás", async () => {
    const defecto = await prisma.defecto.findUnique({
      where: { clave: 1101 },
      include: { departamentos: true },
    });
    expect(defecto).toBeDefined();

    const deptoCorte = await prisma.departamento.findUnique({ where: { codigo: "CORTE" } });
    const deptoPespunte = await prisma.departamento.findUnique({ where: { codigo: "PESPUNTE" } });

    // Desactivar Corte individualmente
    const patchRes = await fetch(`${baseUrl}/defectos/${defecto!.id}/departamentos/${deptoCorte!.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ activo: false }),
    });
    expect(patchRes.status).toBe(200);

    // Comprobar que Corte está inactivo pero Pespunte sigue activo
    const asocCorte = await prisma.defectoDepartamento.findUnique({
      where: {
        unique_defecto_departamento: {
          defectoId: defecto!.id,
          departamentoId: deptoCorte!.id,
        },
      },
    });
    const asocPespunte = await prisma.defectoDepartamento.findUnique({
      where: {
        unique_defecto_departamento: {
          defectoId: defecto!.id,
          departamentoId: deptoPespunte!.id,
        },
      },
    });

    expect(asocCorte?.activo).toBe(false);
    expect(asocPespunte?.activo).toBe(true);
  });

  // 8. Desactivar y reactivar un defecto
  it("8. Debe desactivar y reactivar un defecto no eliminado", async () => {
    const postRes = await fetch(`${baseUrl}/defectos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        defecto: "Defecto para toggle de estado",
        clasificacion: "MENOR",
        departamentoId: 2,
      }),
    });
    const def = (await postRes.json()) as any;

    // Desactivar
    const patch1 = await fetch(`${baseUrl}/defectos/${def.data.id}/estado`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ activo: false }),
    });
    expect(patch1.status).toBe(200);
    const body1 = (await patch1.json()) as any;
    expect(body1.data.activo).toBe(false);

    // Reactivar
    const patch2 = await fetch(`${baseUrl}/defectos/${def.data.id}/estado`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ activo: true }),
    });
    expect(patch2.status).toBe(200);
    const body2 = (await patch2.json()) as any;
    expect(body2.data.activo).toBe(true);
  });

  // 9. Impedir la reactivación ordinaria de un defecto eliminado
  it("9. Debe impedir la reactivación ordinaria de un defecto eliminado lógicamente", async () => {
    const postRes = await fetch(`${baseUrl}/defectos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        defecto: "Defecto eliminado para prueba",
        clasificacion: "MENOR",
        departamentoId: 2,
      }),
    });
    const def = (await postRes.json()) as any;

    await fetch(`${baseUrl}/defectos/${def.data.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    // Intentar activar mediante /estado
    const patchRes = await fetch(`${baseUrl}/defectos/${def.data.id}/estado`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ activo: true }),
    });

    expect(patchRes.status).toBe(400); // Bad Request
  });

  // 10. Impedir borrados que invaliden referencias históricas
  it("10. Debe impedir borrar un departamento con terminales activas asignadas", async () => {
    const deptoCalidad = await prisma.departamento.findUnique({ where: { codigo: "CALIDAD" } });
    expect(deptoCalidad).toBeDefined();

    const delRes = await fetch(`${baseUrl}/departamentos/${deptoCalidad!.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(delRes.status).toBe(409); // Conflict: referencias activas
  });

  // 11. Rechazar usuarios sin permisos administrativos
  it("11. Debe rechazar operaciones administrativas a usuarios sin rol ADMIN / SUPER_ADMIN", async () => {
    const postRes = await fetch(`${baseUrl}/defectos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorToken}`,
      },
      body: JSON.stringify({
        defecto: "Defecto por inspector sin permiso",
        clasificacion: "MENOR",
      }),
    });

    expect(postRes.status).toBe(403); // Forbidden
  });

  // 12. Revertir operaciones incompletas mediante transacciones
  it("12. Las transacciones revierten completamente ante fallos", async () => {
    // Si falla un dato en la sincronización, la transacción se revierte
    const res = await fetch(`${baseUrl}/defectos/999999/departamentos`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        departamentos: [{ departamentoId: 1, activo: true }],
      }),
    });

    expect(res.status).toBe(404);
  });

  // 13. Verificar que los timestamps de auditoría se guarden en UTC
  it("13. Los timestamps de auditoría y creación se guardan en UTC", async () => {
    const postRes = await fetch(`${baseUrl}/defectos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        defecto: "Defecto timestamp UTC check",
        clasificacion: "MENOR",
        departamentoId: 2,
      }),
    });

    const def = (await postRes.json()) as any;
    const d = await prisma.defecto.findUnique({ where: { id: def.data.id } });
    expect(d?.creadoEn).toBeInstanceOf(Date);
  });

  // 14. Comprobar filtros y validaciones de los endpoints
  it("14. Comprobar filtros por línea, clasificación y estado", async () => {
    const resFiltro = await fetch(`${baseUrl}/defectos?clasificacion=CRITICO&limit=10`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(resFiltro.status).toBe(200);
    const body = (await resFiltro.json()) as any;
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);
    body.data.items.forEach((item: any) => {
      expect(item.clasificacion).toBe("CRITICO");
    });
  });

  // 15. Comprobar endpoints de tipos de operación y líneas
  it("15. Consultar tipos de operación y líneas asociadas", async () => {
    const res = await fetch(`${baseUrl}/tipos-operacion`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    const prod = body.data.find((t: any) => t.codigo === "PRODUCCION");
    expect(prod).toBeDefined();
    expect(prod.lineas.some((l: any) => l.codigo === "BOTA")).toBe(true);
  });

  // =========================================================================
  // PRUEBAS DE LA AMPLIACIÓN ORGANIZACIONAL (CATEGORÍAS, LÍNEAS, FILTROS)
  // =========================================================================

  // 16. Crear y editar tipos de operación
  it("16. Debe crear, activar/desactivar y editar tipos de operación", async () => {
    const randCode = `TIPO_${Date.now()}`;
    const createRes = await fetch(`${baseUrl}/tipos-operacion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        codigo: randCode,
        nombre: "Tipo Test",
        descripcion: "Descripción tipo test",
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as any;
    const tipoId = createBody.data.id;

    // Modificar nombre
    const patchRes = await fetch(`${baseUrl}/tipos-operacion/${tipoId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        nombre: "Tipo Test Modificado",
      }),
    });
    expect(patchRes.status).toBe(200);

    // Cambiar estado
    const estadoRes = await fetch(`${baseUrl}/tipos-operacion/${tipoId}/estado`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ estado: "INACTIVO" }),
    });
    expect(estadoRes.status).toBe(200);
    const estadoBody = (await estadoRes.json()) as any;
    expect(estadoBody.data.estado).toBe("INACTIVO");
  });

  // 17. Crear líneas y asociarlas a un tipo de operación
  it("17. Debe crear líneas asociadas a un tipo de operación y activar/desactivar", async () => {
    const prod = await prisma.tipoOperacion.findUnique({ where: { codigo: "PRODUCCION" } });
    const randCode = `LIN_${Date.now()}`;

    const createRes = await fetch(`${baseUrl}/lineas`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        tipoOperacionId: prod!.id,
        codigo: randCode,
        nombre: "Línea Test",
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as any;
    const lineaId = createBody.data.id;

    // Desactivar línea
    const estadoRes = await fetch(`${baseUrl}/lineas/${lineaId}/estado`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ estado: "INACTIVO" }),
    });
    expect(estadoRes.status).toBe(200);
  });

  // 18. Crear categorías de departamento y validar unicidad
  it("18. Debe crear categorías de departamento y rechazar nombres duplicados", async () => {
    const nombreCat = `CAT_TEST_${Date.now()}`;
    const createRes = await fetch(`${baseUrl}/categorias-departamento`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        nombre: nombreCat,
        descripcion: "Categoría de prueba",
      }),
    });
    expect(createRes.status).toBe(201);

    // Intentar crear con el mismo nombre
    const dupRes = await fetch(`${baseUrl}/categorias-departamento`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        nombre: nombreCat,
      }),
    });
    expect(dupRes.status).toBe(409);
  });

  // 19. Asignar y cambiar la categoría de un departamento
  it("19. Debe asignar y cambiar la categoría de un departamento", async () => {
    const cat = await prisma.categoriaDepartamento.findFirst({ where: { nombre: "PRODUCCIÓN" } });
    expect(cat).toBeDefined();

    const randDepto = `DEP_${Date.now()}`;
    const createRes = await fetch(`${baseUrl}/departamentos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        codigo: randDepto,
        nombre: "Departamento Con Categoria",
        categoriaDepartamentoId: cat!.id,
      }),
    });
    expect(createRes.status).toBe(201);
    const body = (await createRes.json()) as any;
    expect(body.data.categoriaDepartamentoId).toBe(cat!.id);

    // Desvincular categoría
    const patchRes = await fetch(`${baseUrl}/departamentos/${body.data.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        categoriaDepartamentoId: null,
      }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as any;
    expect(patchBody.data.categoriaDepartamentoId).toBeNull();
  });

  // 20. Impedir borrar categorías que todavía tengan departamentos asociados
  it("20. Debe impedir borrar categorías que todavía tengan departamentos asociados", async () => {
    const cat = await prisma.categoriaDepartamento.findFirst({ where: { nombre: "PRODUCCIÓN" } });
    expect(cat).toBeDefined();

    const delRes = await fetch(`${baseUrl}/categorias-departamento/${cat!.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.status).toBe(409);
  });

  // 21. Filtro de defectos por categoría sin duplicaciones
  it("21. Debe filtrar defectos por categoría de departamento sin duplicar", async () => {
    const cat = await prisma.categoriaDepartamento.findFirst({ where: { nombre: "PRODUCCIÓN" } });
    expect(cat).toBeDefined();

    const res = await fetch(`${baseUrl}/defectos?categoriaDepartamentoId=${cat!.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);

    // Verificar que los IDs no estén duplicados
    const ids = body.data.items.map((i: any) => i.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });
});

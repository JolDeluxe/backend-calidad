import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../src/config/database";
import { inspeccionesService } from "../src/modules/inspecciones/services/inspecciones.service";

describe("Filtro Estricto por Departamento Responsable en Registro", () => {
  let deptoPreliminares: { id: number; codigo: string; nombre: string };
  let deptoBordado: { id: number; codigo: string; nombre: string };
  let inspectorTest: { id: number; usuario: string };
  let terminalTest: { id: number; nombre: string };
  let loteTest: { id: number; lote: string; lista: string };
  let defectoPrelim: { id: number; clave: number; defecto: string; departamentoId: number };
  let defectoBordado: { id: number; clave: number; defecto: string; departamentoId: number };

  let inspeccionCabeceraId: number;
  let detallePrelimId: number;
  let detalleBordadoId: number;

  beforeAll(async () => {
    // 1. Obtener o verificar departamentos PRELIMINARES y BORDADO_Y_LASER
    const prelim = await prisma.departamento.findFirst({
      where: { OR: [{ id: 2 }, { codigo: "PRELIMINARES" }] },
    });
    const bordado = await prisma.departamento.findFirst({
      where: { OR: [{ id: 3 }, { codigo: { in: ["BORDADO_Y_LASER", "BORDADO"] } }] },
    });

    if (!prelim || !bordado) {
      throw new Error("Departamentos PRELIMINARES o BORDADO no encontrados en la base de datos");
    }

    deptoPreliminares = { id: prelim.id, codigo: prelim.codigo, nombre: prelim.nombre };
    deptoBordado = { id: bordado.id, codigo: bordado.codigo, nombre: bordado.nombre };

    // 2. Obtener o crear inspector de prueba
    let inspector = await prisma.usuario.findFirst({
      where: { rol: { codigo: "INSPECTOR" }, estado: "ACTIVO" },
    });
    if (!inspector) {
      const rolInspector = await prisma.rol.findFirst({ where: { codigo: "INSPECTOR" } });
      inspector = await prisma.usuario.create({
        data: {
          usuario: `insp_test_${Date.now()}`,
          nombre: "Inspector Test Filtro",
          passwordHash: "hash_test_123",
          rolId: rolInspector!.id,
          estado: "ACTIVO",
        },
      });
    }
    inspectorTest = { id: inspector.id, usuario: inspector.usuario };

    // 3. Crear terminal de prueba compartida
    const term = await prisma.terminal.create({
      data: {
        nombre: `TERM-TEST-COMPARTIDA-${Date.now()}`,
        departamentoId: deptoPreliminares.id,
        estado: "ACTIVO",
        credencialHash: `cred_hash_test_${Date.now()}`,
        departamentos: {
          create: [
            { departamentoId: deptoPreliminares.id, esPrincipal: true, activo: true },
            { departamentoId: deptoBordado.id, esPrincipal: false, activo: true },
          ],
        },
      },
    });
    terminalTest = { id: term.id, nombre: term.nombre };

    // 4. Crear lote de prueba
    const timestamp = Date.now();
    const loteDb = await prisma.produccionLote.create({
      data: {
        listaLote: `[L]TEST${timestamp}`,
        lista: "TEST",
        lote: `LOTE_${timestamp}`,
        idProducto: "103Z2LPH9052CUH",
        modelo: "3Z2LPH",
        cantidad: 50,
        cliente: "CLIENTE TEST FILTRO",
        estado: "ACTIVO",
      },
    });
    loteTest = { id: loteDb.id, lote: loteDb.lote, lista: loteDb.lista };

    // 5. Obtener o crear defecto propio de Preliminares
    let defP = await prisma.defecto.findFirst({
      where: { departamentoId: deptoPreliminares.id, activo: true },
    });
    if (!defP) {
      defP = await prisma.defecto.create({
        data: {
          clave: 98701,
          defecto: "DEFECTO TEST PRELIMINARES",
          clasificacion: "MENOR",
          departamentoId: deptoPreliminares.id,
          activo: true,
          creadoPor: inspector.id,
        },
      });
    }
    defectoPrelim = { id: defP.id, clave: defP.clave, defecto: defP.defecto, departamentoId: defP.departamentoId };

    // 6. Obtener o crear defecto propio de Bordado
    let defB = await prisma.defecto.findFirst({
      where: { departamentoId: deptoBordado.id, activo: true },
    });
    if (!defB) {
      defB = await prisma.defecto.create({
        data: {
          clave: 98702,
          defecto: "DEFECTO TEST BORDADO",
          clasificacion: "MENOR",
          departamentoId: deptoBordado.id,
          activo: true,
          creadoPor: inspector.id,
        },
      });
    }
    defectoBordado = { id: defB.id, clave: defB.clave, defecto: defB.defecto, departamentoId: defB.departamentoId };

    // 7. Crear inspección auditada en PRELIMINARES con 2 defectos:
    // - Uno responsable PRELIMINARES
    // - Uno responsable BORDADO (detectado en Preliminares)
    const hoyUtc = new Date();
    const insp = await prisma.inspeccionCabecera.create({
      data: {
        folio: `INSP-TEST-${timestamp}`,
        departamentoAuditoriaId: deptoPreliminares.id,
        terminalId: terminalTest.id,
        inspectorId: inspectorTest.id,
        loteId: loteTest.id,
        fechaInspeccion: hoyUtc,
        detalles: {
          create: [
            {
              defectoId: defectoPrelim.id,
              defDeptoId: deptoPreliminares.id,
              paresDefectuosos: 2,
            },
            {
              defectoId: defectoBordado.id,
              defDeptoId: deptoBordado.id,
              paresDefectuosos: 1,
            },
          ],
        },
      },
      include: {
        detalles: true,
      },
    });

    inspeccionCabeceraId = insp.id;
    const detP = insp.detalles.find((d) => d.defDeptoId === deptoPreliminares.id);
    const detB = insp.detalles.find((d) => d.defDeptoId === deptoBordado.id);
    detallePrelimId = detP!.id;
    detalleBordadoId = detB!.id;
  });

  afterAll(async () => {
    // Limpieza estricta de fixtures de prueba
    if (inspeccionCabeceraId) {
      await prisma.inspeccionDetalle.deleteMany({ where: { inspeccionId: inspeccionCabeceraId } });
      await prisma.inspeccionCabecera.deleteMany({ where: { id: inspeccionCabeceraId } });
    }
    if (loteTest?.id) {
      await prisma.produccionLote.deleteMany({ where: { id: loteTest.id } });
    }
    if (terminalTest?.id) {
      await prisma.terminalDepartamento.deleteMany({ where: { terminalId: terminalTest.id } });
      await prisma.terminal.deleteMany({ where: { id: terminalTest.id } });
    }
  });

  // Requisito 1: Filtrar PRELIMINARES devuelve exclusivamente registros con defDeptoId = preliminares
  it("1. Filtrar PRELIMINARES devuelve exclusivamente registros con defDeptoId de PRELIMINARES", async () => {
    const res = await inspeccionesService.getFilasInspeccion({
      periodo: "hoy",
      departamentoId: deptoPreliminares.id,
      page: 1,
      limit: 100,
    });

    expect(res).toBeDefined();
    expect(res.items.length).toBeGreaterThanOrEqual(1);

    // Todos los registros devueltos deben ser estrictamente del departamento Preliminares
    for (const item of res.items) {
      expect(item.defDepto.toUpperCase()).toBe(deptoPreliminares.nombre.toUpperCase());
    }

    const testItem = res.items.find((i) => i.id === detallePrelimId);
    expect(testItem).toBeDefined();
  });

  // Requisito 2: Un defecto de BORDADO detectado en PRELIMINARES NO aparece al filtrar PRELIMINARES
  it("2. Un defecto de BORDADO detectado durante inspección en PRELIMINARES NO aparece al filtrar PRELIMINARES", async () => {
    const res = await inspeccionesService.getFilasInspeccion({
      periodo: "hoy",
      departamentoId: deptoPreliminares.id,
      page: 1,
      limit: 100,
    });

    const itemBordadoEnPrelim = res.items.find((i) => i.id === detalleBordadoId);
    expect(itemBordadoEnPrelim).toBeUndefined();
  });

  // Requisito 3: Ese mismo defecto de BORDADO sí aparece al filtrar BORDADO Y LÁSER
  it("3. El defecto de BORDADO detectado en Preliminares sí aparece al filtrar BORDADO Y LÁSER", async () => {
    const res = await inspeccionesService.getFilasInspeccion({
      periodo: "hoy",
      departamentoId: deptoBordado.id,
      page: 1,
      limit: 100,
    });

    const itemBordado = res.items.find((i) => i.id === detalleBordadoId);
    expect(itemBordado).toBeDefined();
    expect(itemBordado?.defDepto.toUpperCase()).toBe(deptoBordado.nombre.toUpperCase());
    // Se confirma que el lugar de detección fue PRELIMINARES pero el departamento responsable es BORDADO
    expect(itemBordado?.departamentoAuditoriaCodigo).toBe(deptoPreliminares.codigo);
  });

  // Requisito 4: Los registros de PRELIMINARES siguen apareciendo aunque hayan sido capturados desde terminal compartida
  it("4. Registros de PRELIMINARES siguen apareciendo al capturarse desde terminal compartida", async () => {
    const res = await inspeccionesService.getFilasInspeccion({
      periodo: "hoy",
      departamentoId: deptoPreliminares.id,
      page: 1,
      limit: 100,
    });

    const testItem = res.items.find((i) => i.id === detallePrelimId);
    expect(testItem).toBeDefined();
    expect(testItem?.terminal).toBe(terminalTest.nombre);
    expect(testItem?.defDepto.toUpperCase()).toBe(deptoPreliminares.nombre.toUpperCase());
  });

  // Requisito 5: Los filtros combinados de fecha y departamento funcionan correctamente
  it("5. Filtros combinados de fecha y departamento funcionan con precisión", async () => {
    // Consulta con fecha de hoy
    const resHoy = await inspeccionesService.getFilasInspeccion({
      periodo: "hoy",
      departamentoId: deptoPreliminares.id,
      page: 1,
      limit: 50,
    });
    expect(resHoy.items.some((i) => i.id === detallePrelimId)).toBe(true);

    // Consulta con rango de fecha futura (no debe encontrar el registro)
    const resFuturo = await inspeccionesService.getFilasInspeccion({
      periodo: "dia",
      dia: "2029-01-01",
      departamentoId: deptoPreliminares.id,
      page: 1,
      limit: 50,
    });
    expect(resFuturo.items.length).toBe(0);
  });

  // Requisito 6: Los totales de paginación coinciden con los registros obtenidos
  it("6. Los totales de paginación coinciden con los registros filtrados", async () => {
    const res = await inspeccionesService.getFilasInspeccion({
      periodo: "hoy",
      departamentoId: deptoPreliminares.id,
      page: 1,
      limit: 10,
    });

    expect(res.total).toBeGreaterThanOrEqual(1);
    expect(res.totalDefectos).toBe(res.total);
    expect(res.totalPages).toBe(Math.ceil(res.total / 10));
    expect(res.items.length).toBeLessThanOrEqual(10);
  });

  // Requisito 7: Las exportaciones respetan exactamente el mismo filtro estricto
  it("7. Las exportaciones respetan exactamente el filtro de departamento responsable", async () => {
    const resExport = await inspeccionesService.exportarFilasInspeccion({
      periodo: "hoy",
      departamentoId: deptoPreliminares.id,
    });

    expect(resExport.items.length).toBeGreaterThanOrEqual(1);

    // Debe contener el defecto de Preliminares
    const testItemPrelim = resExport.items.find((i) => i.id === detallePrelimId);
    expect(testItemPrelim).toBeDefined();

    // NO debe contener el defecto de Bordado
    const testItemBordado = resExport.items.find((i) => i.id === detalleBordadoId);
    expect(testItemBordado).toBeUndefined();

    // Todos los registros exportados deben pertenecer a Preliminares
    for (const item of resExport.items) {
      expect(item.defDepto.toUpperCase()).toBe(deptoPreliminares.nombre.toUpperCase());
    }
  });

  // Requisito 8: Registro sin filtro departamental muestra todos los defectos
  it("8. Registro sin filtro departamental incluye defectos de todos los departamentos", async () => {
    const resSinDepto = await inspeccionesService.getFilasInspeccion({
      periodo: "hoy",
      page: 1,
      limit: 100,
    });

    // Sin filtro deben coexistir el de Preliminares y el de Bordado
    expect(resSinDepto.items.some((i) => i.id === detallePrelimId)).toBe(true);
    expect(resSinDepto.items.some((i) => i.id === detalleBordadoId)).toBe(true);
  });

  // Requisito 9: Registro con múltiples departamentos filtra exclusivamente los departamentos solicitados
  it("9. Registro con múltiples departamentos (departamentosIds) incluye solo los departamentos solicitados", async () => {
    const resMulti = await inspeccionesService.getFilasInspeccion({
      periodo: "hoy",
      departamentosIds: [deptoPreliminares.id, deptoBordado.id],
      page: 1,
      limit: 100,
    });

    expect(resMulti.items.some((i) => i.id === detallePrelimId)).toBe(true);
    expect(resMulti.items.some((i) => i.id === detalleBordadoId)).toBe(true);

    for (const item of resMulti.items) {
      expect([deptoPreliminares.nombre.toUpperCase(), deptoBordado.nombre.toUpperCase()]).toContain(
        item.defDepto.toUpperCase()
      );
    }
  });

  // Requisito 10: getPeriodosDisponibles sin departamento y con departamento
  it("10. getPeriodosDisponibles funciona correctamente con y sin filtro departamental", async () => {
    // Con departamento Preliminares
    const periodosPrelim = await inspeccionesService.getPeriodosDisponibles({
      departamentoId: deptoPreliminares.id,
    });
    expect(periodosPrelim).toBeDefined();
    expect(Array.isArray(periodosPrelim.anios)).toBe(true);
    expect(periodosPrelim.rangoTotal).toBeDefined();

    // Sin departamento: muestra periodos globales
    const periodosGlobal = await inspeccionesService.getPeriodosDisponibles({});
    expect(periodosGlobal).toBeDefined();
    expect(Array.isArray(periodosGlobal.anios)).toBe(true);
    expect(periodosGlobal.rangoTotal).toBeDefined();

    // Con múltiples departamentos
    const periodosMulti = await inspeccionesService.getPeriodosDisponibles({
      departamentosIds: [deptoPreliminares.id, deptoBordado.id],
    });
    expect(periodosMulti).toBeDefined();
    expect(Array.isArray(periodosMulti.anios)).toBe(true);
  });

  // Requisito 11: Distinción entre departamento auditor y departamento responsable
  it("11. Reportes y consultas que distinguen departamentoAuditoriaId de departamentoResponsableId", async () => {
    // Si se consulta explícitamente por departamentoAuditoriaId = Preliminares,
    // se obtienen los defectos inspeccionados en Preliminares (incluso el de Bordado)
    const resAuditoria = await inspeccionesService.getFilasInspeccion({
      periodo: "hoy",
      departamentoAuditoriaId: deptoPreliminares.id,
      page: 1,
      limit: 100,
    });
    expect(resAuditoria.items.some((i) => i.id === detallePrelimId)).toBe(true);
    expect(resAuditoria.items.some((i) => i.id === detalleBordadoId)).toBe(true);

    // Si se consulta explícitamente por departamentoResponsableId = Bordado,
    // solo se obtiene el defecto de Bordado
    const resResponsable = await inspeccionesService.getFilasInspeccion({
      periodo: "hoy",
      departamentoResponsableId: deptoBordado.id,
      page: 1,
      limit: 100,
    });
    expect(resResponsable.items.some((i) => i.id === detalleBordadoId)).toBe(true);
    expect(resResponsable.items.some((i) => i.id === detallePrelimId)).toBe(false);
  });
});

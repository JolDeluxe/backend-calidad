import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../src/config/database";
import { defectosService } from "../src/modules/defectos/services/defectos.service";

describe("Validación de defectos para captura de inspección", () => {
  let deptoAuditorId: number;
  let deptoOtroId: number;
  let usuarioId: number;
  let claveActivoPermitido = 9901;
  let claveInactivo = 9902;
  let claveNoPermitido = 9903;
  let defectoActivoId: number;
  let defectoInactivoId: number;
  let defectoNoPermitidoId: number;

  beforeAll(async () => {
    // 1. Obtener usuario existente para auditoría
    const usuario = await prisma.usuario.findFirst({ where: { estado: "ACTIVO" } });
    if (!usuario) throw new Error("No hay usuarios activos para test");
    usuarioId = usuario.id;

    // 2. Obtener departamentos
    const deptos = await prisma.departamento.findMany({
      where: { estado: "ACTIVO", eliminadoEn: null },
      take: 2,
    });
    if (deptos.length < 2) throw new Error("Se requieren al menos 2 departamentos activos");
    deptoAuditorId = deptos[0].id;
    deptoOtroId = deptos[1].id;

    // Limpiar claves de prueba previas si existieran
    await prisma.defectoEtapa.deleteMany({
      where: { defecto: { clave: { in: [claveActivoPermitido, claveInactivo, claveNoPermitido] } } },
    });
    await prisma.defectoDepartamento.deleteMany({
      where: { defecto: { clave: { in: [claveActivoPermitido, claveInactivo, claveNoPermitido] } } },
    });
    await prisma.defecto.deleteMany({
      where: { clave: { in: [claveActivoPermitido, claveInactivo, claveNoPermitido] } },
    });

    // Crear Defecto 1: Activo y permitido en deptoAuditorId
    const d1 = await prisma.defecto.create({
      data: {
        clave: claveActivoPermitido,
        defecto: "Defecto Test Activo Permitido",
        clasificacion: "MAYOR",
        departamentoId: deptoAuditorId,
        activo: true,
        creadoPor: usuarioId,
      },
    });
    defectoActivoId = d1.id;
    await prisma.defectoEtapa.create({
      data: {
        defectoId: d1.id,
        departamentoId: deptoAuditorId,
        permitido: true,
        creadoPor: usuarioId,
      },
    });

    // Crear Defecto 2: Inactivo (activo = false)
    const d2 = await prisma.defecto.create({
      data: {
        clave: claveInactivo,
        defecto: "Defecto Test Inactivo",
        clasificacion: "MENOR",
        departamentoId: deptoAuditorId,
        activo: false,
        creadoPor: usuarioId,
      },
    });
    defectoInactivoId = d2.id;
    await prisma.defectoEtapa.create({
      data: {
        defectoId: d2.id,
        departamentoId: deptoAuditorId,
        permitido: true,
        creadoPor: usuarioId,
      },
    });

    // Crear Defecto 3: Activo pero NO permitido en deptoAuditorId (permitido solo en deptoOtroId)
    const d3 = await prisma.defecto.create({
      data: {
        clave: claveNoPermitido,
        defecto: "Defecto Test No Permitido en Auditor",
        clasificacion: "CRITICO",
        departamentoId: deptoOtroId,
        activo: true,
        creadoPor: usuarioId,
      },
    });
    defectoNoPermitidoId = d3.id;
    await prisma.defectoEtapa.create({
      data: {
        defectoId: d3.id,
        departamentoId: deptoOtroId,
        permitido: true,
        creadoPor: usuarioId,
      },
    });
  });

  afterAll(async () => {
    // Limpieza
    await prisma.defectoEtapa.deleteMany({
      where: { defectoId: { in: [defectoActivoId, defectoInactivoId, defectoNoPermitidoId] } },
    });
    await prisma.defecto.deleteMany({
      where: { id: { in: [defectoActivoId, defectoInactivoId, defectoNoPermitidoId] } },
    });
  });

  it("Escenario 1: Clave que no existe en el catálogo devuelve 'Defecto inexistente'", async () => {
    const res = await defectosService.validarDefectoParaCaptura(999999, deptoAuditorId);
    expect(res.estado).toBe("INEXISTENTE");
    expect(res.mensaje).toBe("Defecto inexistente");
    expect(res.defecto).toBeNull();
  });

  it("Escenario 2: Defecto inactivo devuelve 'Defecto inactivo'", async () => {
    const res = await defectosService.validarDefectoParaCaptura(claveInactivo, deptoAuditorId);
    expect(res.estado).toBe("INACTIVO");
    expect(res.mensaje).toBe("Defecto inactivo");
    expect(res.defecto).toBeNull();
  });

  it("Escenario 3: Defecto activo pero no autorizado en la etapa devuelve 'Defecto no permitido'", async () => {
    const res = await defectosService.validarDefectoParaCaptura(claveNoPermitido, deptoAuditorId);
    expect(res.estado).toBe("NO_PERMITIDO");
    expect(res.mensaje).toBe("Defecto no permitido");
    expect(res.defecto).toBeNull();
  });

  it("Escenario 4: Defecto válido devuelve 'Defecto válido' y el payload del defecto", async () => {
    const res = await defectosService.validarDefectoParaCaptura(claveActivoPermitido, deptoAuditorId);
    expect(res.estado).toBe("VALIDO");
    expect(res.mensaje).toBe("Defecto válido");
    expect(res.defecto).not.toBeNull();
    expect(res.defecto?.clave).toBe(claveActivoPermitido);
  });
});

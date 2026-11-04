import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../src/config/database";
import { defectosService } from "../src/modules/defectos/services/defectos.service";
import { matrizVisibilidadDefectosService } from "../src/modules/defectos/services/matriz-visibilidad.service";

describe("Fase 2.1 — Pruebas Funcionales Obligatorias de Visibilidad entre Departamentos", () => {
  let deptoCorteId: number;
  let deptoAcabadoId: number;
  let deptoAviosId: number;
  let adminUserId: number;
  let defectoTestClave: number;
  let defectoTestId: number;

  beforeAll(async () => {
    const deptos = await prisma.departamento.findMany();
    deptoCorteId = deptos.find((d) => d.codigo === "CORTE")!.id;
    deptoAcabadoId = deptos.find((d) => d.codigo === "ACABADO")!.id;
    deptoAviosId = deptos.find((d) => d.codigo === "AVIOS")!.id;

    const admin = await prisma.usuario.findFirst({ where: { usuario: "admin" } });
    adminUserId = admin!.id;

    defectoTestClave = 99881;
    // Asegurar limpieza de prueba previa
    await prisma.defectoEtapa.deleteMany({ where: { defecto: { clave: defectoTestClave } } });
    await prisma.defectoDepartamento.deleteMany({ where: { defecto: { clave: defectoTestClave } } });
    await prisma.defecto.deleteMany({ where: { clave: defectoTestClave } });

    // Crear defecto sin excepciones explícitas
    const d = await defectosService.createDefecto(
      {
        clave: defectoTestClave,
        defecto: "Defecto Test Fase 2.1 Visibilidad",
        clasificacion: "CRITICO",
        departamentoId: deptoCorteId,
      },
      adminUserId
    );
    defectoTestId = d.id;
  });

  afterAll(async () => {
    if (defectoTestId) {
      await prisma.defectoEtapa.deleteMany({ where: { defectoId: defectoTestId } });
      await prisma.defectoDepartamento.deleteMany({ where: { defectoId: defectoTestId } });
      await prisma.defecto.deleteMany({ where: { id: defectoTestId } });
    }
    // Restaurar matriz autorizada CORTE -> ACABADO = true
    await matrizVisibilidadDefectosService.upsertRegla(
      deptoCorteId,
      deptoAcabadoId,
      true,
      adminUserId
    );
  });

  it("Prueba 1 — Defecto heredado aparece en el listado del departamento de detección", async () => {
    // 1. Asegurar matriz CORTE -> ACABADO = true
    await matrizVisibilidadDefectosService.upsertRegla(
      deptoCorteId,
      deptoAcabadoId,
      true,
      adminUserId
    );

    // 2. Consultar listado de defectos disponibles en ACABADO
    const listado = await defectosService.getDefectos({
      etapaId: deptoAcabadoId,
      limit: 500,
    });

    const encontrado = listado.items.find((x) => x.clave === defectoTestClave);
    expect(encontrado).toBeDefined();
    expect(encontrado?.departamentoId).toBe(deptoCorteId);
  });

  it("Prueba 2 — Cambio dinámico en la matriz retira el defecto del listado sin modificar el defecto", async () => {
    // 1. Cambiar matriz CORTE -> ACABADO a false
    await matrizVisibilidadDefectosService.upsertRegla(
      deptoCorteId,
      deptoAcabadoId,
      false,
      adminUserId
    );

    // 2. Consultar nuevamente el listado de ACABADO
    const listado = await defectosService.getDefectos({
      etapaId: deptoAcabadoId,
      limit: 500,
    });

    const encontrado = listado.items.find((x) => x.clave === defectoTestClave);
    expect(encontrado).toBeUndefined();
  });

  it("Prueba 3 — Excepción individual positiva (true) prevalece sobre matriz en false", async () => {
    // Matriz sigue en false
    // 1. Crear excepción individual explícita true para ACABADO
    await defectosService.syncDefectoEtapas(
      defectoTestId,
      [{ departamentoId: deptoAcabadoId, permitido: true }],
      adminUserId
    );

    // 2. Consultar listado de ACABADO
    const listado = await defectosService.getDefectos({
      etapaId: deptoAcabadoId,
      limit: 500,
    });

    const encontrado = listado.items.find((x) => x.clave === defectoTestClave);
    expect(encontrado).toBeDefined();
  });

  it("Prueba 4 — Excepción individual negativa (false) bloquea el defecto aunque la matriz esté en true", async () => {
    // 1. Poner matriz CORTE -> ACABADO en true
    await matrizVisibilidadDefectosService.upsertRegla(
      deptoCorteId,
      deptoAcabadoId,
      true,
      adminUserId
    );

    // 2. Modificar la excepción individual a false
    await defectosService.syncDefectoEtapas(
      defectoTestId,
      [{ departamentoId: deptoAcabadoId, permitido: false }],
      adminUserId
    );

    // 3. Consultar listado de ACABADO
    const listado = await defectosService.getDefectos({
      etapaId: deptoAcabadoId,
      limit: 500,
    });

    const encontrado = listado.items.find((x) => x.clave === defectoTestClave);
    expect(encontrado).toBeUndefined();
  });

  it("Prueba 5 — Eliminación de la excepción restaura la herencia dinámica de la matriz", async () => {
    // 1. Eliminar la excepción en DefectoEtapa
    await prisma.defectoEtapa.deleteMany({
      where: { defectoId: defectoTestId, departamentoId: deptoAcabadoId }
    });

    // 2. Con la matriz en true y sin excepción, el defecto debe reaparecer en ACABADO
    const listado = await defectosService.getDefectos({
      etapaId: deptoAcabadoId,
      limit: 500,
    });

    const encontrado = listado.items.find((x) => x.clave === defectoTestClave);
    expect(encontrado).toBeDefined();
  });

  it("Prueba 6 — IDs sin orden semántico: la visibilidad es por pareja y no por magnitud de ID", async () => {
    // CORTE (ID 1) y AVIOS (ID 7): aunque 1 < 7, la matriz CORTE -> AVIOS está en false
    const resAvios = await matrizVisibilidadDefectosService.resolverVisibilidad(
      defectoTestId,
      deptoAviosId
    );
    expect(resAvios.permitido).toBe(false);

    // CORTE (ID 1) y ACABADO (ID 6): 1 < 6, permitido es true
    const resAcabado = await matrizVisibilidadDefectosService.resolverVisibilidad(
      defectoTestId,
      deptoAcabadoId
    );
    expect(resAcabado.permitido).toBe(true);
  });

  it("Prueba 7 — Departamento sin matriz aplica compatibilidad estricta", async () => {
    // Consultar visibilidad entre departamentos no configurados
    // Depto origen AVIOS (ID 7) hacia CORTE (ID 1), sin regla configurada:
    const resSinMatriz = await matrizVisibilidadDefectosService.resolverVisibilidadConEntidades(
      deptoAviosId,
      deptoCorteId,
      undefined,
      defectoTestId
    );
    expect(resSinMatriz.permitido).toBe(false);
    expect(resSinMatriz.origenRegla).toBe("DEFAULT_COMPATIBILIDAD");

    // Depto origen AVIOS (ID 7) hacia su propio departamento AVIOS (ID 7):
    const resPropio = await matrizVisibilidadDefectosService.resolverVisibilidadConEntidades(
      deptoAviosId,
      deptoAviosId,
      undefined,
      defectoTestId
    );
    expect(resPropio.permitido).toBe(true);
    expect(resPropio.origenRegla).toBe("DEFAULT_COMPATIBILIDAD");
  });
});

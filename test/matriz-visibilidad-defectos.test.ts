import { describe, it, expect, beforeAll } from "bun:test";
import { prisma } from "../src/config/database";
import { matrizVisibilidadDefectosService } from "../src/modules/defectos/services/matriz-visibilidad.service";
import { defectosService } from "../src/modules/defectos/services/defectos.service";

describe("Matriz Maestra de Visibilidad de Defectos por Departamento", () => {
  let deptoCorteId: number;
  let deptoAcabadoId: number;
  let deptoBordadoId: number;
  let deptoMontadoId: number;
  let deptoPespunteId: number;
  let deptoPreliminaresId: number;
  let deptoAviosId: number;
  let deptoAdornoId: number;
  let defectoCortePruebaId: number;

  beforeAll(async () => {
    const deptos = await prisma.departamento.findMany({ select: { id: true, codigo: true } });
    const mapa = new Map(deptos.map((d) => [d.codigo, d.id]));

    deptoCorteId = mapa.get("CORTE")!;
    deptoAcabadoId = mapa.get("ACABADO")!;
    deptoBordadoId = mapa.get("BORDADO_Y_LASER")!;
    deptoMontadoId = mapa.get("MONTADO")!;
    deptoPespunteId = mapa.get("PESPUNTE")!;
    deptoPreliminaresId = mapa.get("PRELIMINARES")!;
    deptoAviosId = mapa.get("AVIOS")!;
    deptoAdornoId = mapa.get("ADORNO")!;

    // Asegurar que la matriz para CORTE esté cargada
    const reglasCorte: Record<number, boolean> = {
      [deptoAcabadoId]: true,
      [deptoBordadoId]: true,
      [deptoCorteId]: true,
      [deptoMontadoId]: true,
      [deptoPespunteId]: true,
      [deptoPreliminaresId]: true,
      [deptoAviosId]: false,
      [deptoAdornoId]: false,
    };

    for (const [destinoId, permitido] of Object.entries(reglasCorte)) {
      await prisma.departamentoVisibilidadDefecto.upsert({
        where: {
          unique_depto_origen_destino: {
            departamentoOrigenId: deptoCorteId,
            departamentoDestinoId: Number(destinoId),
          },
        },
        create: {
          departamentoOrigenId: deptoCorteId,
          departamentoDestinoId: Number(destinoId),
          permitido,
          creadoPor: 1,
        },
        update: { permitido, actualizadoPor: 1 },
      });
    }

    // Buscar o crear un defecto de CORTE
    let defCorte = await prisma.defecto.findFirst({
      where: { departamentoId: deptoCorteId, activo: true, eliminadoEn: null },
    });
    if (!defCorte) {
      defCorte = await defectosService.createDefecto(
        {
          clave: 99991,
          defecto: "Defecto de prueba matriz corte",
          clasificacion: "CRITICO",
          departamentoId: deptoCorteId,
        },
        1
      );
    }
    defectoCortePruebaId = defCorte.id;
  });

  // 1. Defecto de CORTE permitido en ACABADO
  it("1. Defecto de CORTE permitido en ACABADO", async () => {
    const res = await matrizVisibilidadDefectosService.resolverVisibilidad(defectoCortePruebaId, deptoAcabadoId);
    expect(res.permitido).toBe(true);
  });

  // 2. Defecto de CORTE permitido en BORDADO
  it("2. Defecto de CORTE permitido en BORDADO", async () => {
    const res = await matrizVisibilidadDefectosService.resolverVisibilidad(defectoCortePruebaId, deptoBordadoId);
    expect(res.permitido).toBe(true);
  });

  // 3. Defecto de CORTE permitido en CORTE
  it("3. Defecto de CORTE permitido en CORTE", async () => {
    const res = await matrizVisibilidadDefectosService.resolverVisibilidad(defectoCortePruebaId, deptoCorteId);
    expect(res.permitido).toBe(true);
  });

  // 4. Defecto de CORTE permitido en MONTADO
  it("4. Defecto de CORTE permitido en MONTADO", async () => {
    const res = await matrizVisibilidadDefectosService.resolverVisibilidad(defectoCortePruebaId, deptoMontadoId);
    expect(res.permitido).toBe(true);
  });

  // 5. Defecto de CORTE permitido en PESPUNTE
  it("5. Defecto de CORTE permitido en PESPUNTE", async () => {
    const res = await matrizVisibilidadDefectosService.resolverVisibilidad(defectoCortePruebaId, deptoPespunteId);
    expect(res.permitido).toBe(true);
  });

  // 6. Defecto de CORTE permitido en PRELIMINARES
  it("6. Defecto de CORTE permitido en PRELIMINARES", async () => {
    const res = await matrizVisibilidadDefectosService.resolverVisibilidad(defectoCortePruebaId, deptoPreliminaresId);
    expect(res.permitido).toBe(true);
  });

  // 7. Defecto de CORTE bloqueado en AVÍOS
  it("7. Defecto de CORTE bloqueado en AVÍOS", async () => {
    const res = await matrizVisibilidadDefectosService.resolverVisibilidad(defectoCortePruebaId, deptoAviosId);
    expect(res.permitido).toBe(false);
  });

  // 8. Defecto de CORTE bloqueado en ADORNO
  it("8. Defecto de CORTE bloqueado en ADORNO", async () => {
    const res = await matrizVisibilidadDefectosService.resolverVisibilidad(defectoCortePruebaId, deptoAdornoId);
    expect(res.permitido).toBe(false);
  });

  // 9. Excepción true prevalece sobre matriz false
  it("9. Excepción true prevalece sobre matriz false", async () => {
    // Matriz dice false para CORTE en AVIOS, pero la excepción en DefectoEtapa tiene true
    const res = await matrizVisibilidadDefectosService.resolverVisibilidadConEntidades(
      deptoCorteId,
      deptoAviosId,
      true // Excepción explícita true
    );
    expect(res.permitido).toBe(true);
    expect(res.origenRegla).toBe("EXCEPCION");
  });

  // 10. Excepción false prevalece sobre matriz true
  it("10. Excepción false prevalece sobre matriz true", async () => {
    // Matriz dice true para CORTE en ACABADO, pero la excepción en DefectoEtapa tiene false
    const res = await matrizVisibilidadDefectosService.resolverVisibilidadConEntidades(
      deptoCorteId,
      deptoAcabadoId,
      false // Excepción explícita false
    );
    expect(res.permitido).toBe(false);
    expect(res.origenRegla).toBe("EXCEPCION");
  });

  // 11. Excepción null hereda la matriz
  it("11. Excepción null hereda la matriz", async () => {
    const res = await matrizVisibilidadDefectosService.resolverVisibilidadConEntidades(
      deptoCorteId,
      deptoAcabadoId,
      null // Sin excepción
    );
    expect(res.permitido).toBe(true);
    expect(res.origenRegla).toBe("MATRIZ");
  });

  // 12. Ausencia de matriz aplica correctamente la política de compatibilidad
  it("12. Ausencia de matriz aplica política de compatibilidad (su propio depto permitido, otros bloqueados)", async () => {
    const deptoSinMatrizId = 99999;
    const resMismo = await matrizVisibilidadDefectosService.resolverVisibilidadConEntidades(
      deptoSinMatrizId,
      deptoSinMatrizId,
      null
    );
    expect(resMismo.permitido).toBe(true);
    expect(resMismo.origenRegla).toBe("DEFAULT_COMPATIBILIDAD");

    const resOtro = await matrizVisibilidadDefectosService.resolverVisibilidadConEntidades(
      deptoSinMatrizId,
      deptoAcabadoId,
      null
    );
    expect(resOtro.permitido).toBe(false);
    expect(resOtro.origenRegla).toBe("DEFAULT_COMPATIBILIDAD");
  });

  // 13. Departamento inexistente produce error controlado en endpoints/servicios
  it("13. Departamento inexistente produce error controlado", async () => {
    expect(
      matrizVisibilidadDefectosService.getMatrizPorDepartamento(999999)
    ).rejects.toThrow("El departamento de origen no existe o está inactivo");
  });
});

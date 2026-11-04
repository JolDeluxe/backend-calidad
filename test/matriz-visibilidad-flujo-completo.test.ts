import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../src/config/database";
import { defectosService } from "../src/modules/defectos/services/defectos.service";
import { codificacionDefectosService } from "../src/modules/defectos/services/codificacion-defectos.service";
import { matrizVisibilidadDefectosService } from "../src/modules/defectos/services/matriz-visibilidad.service";

describe("Escenarios Obligatorios: Herencia Dinámica y Excepciones Individuales", () => {
  let deptoCorteId: number;
  let deptoAcabadoId: number;
  let adminUserId: number;

  beforeAll(async () => {
    const deptos = await prisma.departamento.findMany();
    deptoCorteId = deptos.find((d) => d.codigo === "CORTE")!.id;
    deptoAcabadoId = deptos.find((d) => d.codigo === "ACABADO")!.id;

    const admin = await prisma.usuario.findFirst({ where: { usuario: "admin" } });
    adminUserId = admin!.id;
  });

  it("Flujo 1 al 11: Herencia dinámica y ciclo de vida de excepciones", async () => {
    // 1. Configurar CORTE -> ACABADO = true en la matriz maestra
    await matrizVisibilidadDefectosService.upsertRegla(
      deptoCorteId,
      deptoAcabadoId,
      true,
      adminUserId
    );

    // 2. Crear defecto nuevo de CORTE
    const claveTest = 99201;
    // Asegurar limpieza de clave de prueba previa
    await prisma.defectoEtapa.deleteMany({ where: { defecto: { clave: claveTest } } });
    await prisma.defectoDepartamento.deleteMany({ where: { defecto: { clave: claveTest } } });
    await prisma.defecto.deleteMany({ where: { clave: claveTest } });

    const nuevo = await defectosService.createDefecto(
      {
        clave: claveTest,
        defecto: "Defecto Prueba Flujo 1-11",
        clasificacion: "MAYOR",
        departamentoId: deptoCorteId,
      },
      adminUserId
    );

    // 3. Comprobar que no se crea una excepción individual en DefectoEtapa
    const etapasIndividuales = await prisma.defectoEtapa.findMany({
      where: { defectoId: nuevo.id },
    });
    // Al crearse por herencia de la matriz, NO deben existir excepciones booleanas congeladas
    expect(etapasIndividuales.length).toBe(0);

    // 4. Comprobar que el defecto aparece en ACABADO (origenRegla = MATRIZ, permitido = true)
    const vis1 = await matrizVisibilidadDefectosService.resolverVisibilidad(
      nuevo.id,
      deptoAcabadoId
    );
    expect(vis1.permitido).toBe(true);
    expect(vis1.origenRegla).toBe("MATRIZ");

    // 5. Cambiar CORTE -> ACABADO = false en la matriz maestra
    await matrizVisibilidadDefectosService.upsertRegla(
      deptoCorteId,
      deptoAcabadoId,
      false,
      adminUserId
    );

    // 6. Comprobar que el mismo defecto ahora desaparece/bloquea en ACABADO sin haberlo tocado
    const vis2 = await matrizVisibilidadDefectosService.resolverVisibilidad(
      nuevo.id,
      deptoAcabadoId
    );
    expect(vis2.permitido).toBe(false);
    expect(vis2.origenRegla).toBe("MATRIZ");

    // 7. Crear una excepción individual true para este defecto en ACABADO
    await defectosService.syncDefectoEtapas(
      nuevo.id,
      [{ departamentoId: deptoAcabadoId, permitido: true }],
      adminUserId
    );
    const etapasConExcepcion = await prisma.defectoEtapa.findMany({
      where: { defectoId: nuevo.id, departamentoId: deptoAcabadoId },
    });
    expect(etapasConExcepcion.length).toBe(1);
    expect(etapasConExcepcion[0].permitido).toBe(true);

    // 8. Cambiar nuevamente la matriz maestra a false
    await matrizVisibilidadDefectosService.upsertRegla(
      deptoCorteId,
      deptoAcabadoId,
      false,
      adminUserId
    );

    // 9. Comprobar que ese defecto continúa permitido (origenRegla = EXCEPCION, permitido = true)
    const vis3 = await matrizVisibilidadDefectosService.resolverVisibilidad(
      nuevo.id,
      deptoAcabadoId
    );
    expect(vis3.permitido).toBe(true);
    expect(vis3.origenRegla).toBe("EXCEPCION");

    // 10. Eliminar la excepción (borrado físico o revertido de la excepción)
    await prisma.defectoEtapa.deleteMany({
      where: { defectoId: nuevo.id, departamentoId: deptoAcabadoId },
    });

    // 11. Comprobar que vuelve a heredar la matriz false (origenRegla = MATRIZ, permitido = false)
    const vis4 = await matrizVisibilidadDefectosService.resolverVisibilidad(
      nuevo.id,
      deptoAcabadoId
    );
    expect(vis4.permitido).toBe(false);
    expect(vis4.origenRegla).toBe("MATRIZ");

    // Limpieza
    await prisma.defectoDepartamento.deleteMany({ where: { defectoId: nuevo.id } });
    await prisma.defecto.delete({ where: { id: nuevo.id } });
  });
});

import { describe, it, expect } from "bun:test";
import {
  exportarInspeccionesQuerySchema,
  getInspeccionesQuerySchema,
  getPeriodosDisponiblesQuerySchema,
} from "../src/modules/inspecciones/inspecciones.schema";
import { inspeccionesService } from "../src/modules/inspecciones/services/inspecciones.service";
import { prisma } from "../src/config/database";

describe("Exportación y consulta con múltiples departamentos", () => {
  it("Valida y normaliza departamentosIds desde query params (string separado por comas o array)", () => {
    // 1. String con IDs separados por comas
    const parsedString = exportarInspeccionesQuerySchema.parse({
      periodo: "hoy",
      departamentosIds: "2,3,4",
    });
    expect(parsedString.departamentosIds).toEqual([2, 3, 4]);

    // 2. Array de números o strings
    const parsedArray = exportarInspeccionesQuerySchema.parse({
      periodo: "hoy",
      departamentosIds: [2, 3],
    });
    expect(parsedArray.departamentosIds).toEqual([2, 3]);

    // 3. Esquema de inspecciones tabla
    const parsedTabla = getInspeccionesQuerySchema.parse({
      periodo: "hoy",
      departamentosIds: "5, 6",
    });
    expect(parsedTabla.departamentosIds).toEqual([5, 6]);

    // 4. Esquema de periodos disponibles
    const parsedPeriodos = getPeriodosDisponiblesQuerySchema.parse({
      departamentosIds: "2,3",
    });
    expect(parsedPeriodos.departamentosIds).toEqual([2, 3]);
  });

  it("exportarFilasInspeccion acepta múltiples departamentos sin error de schema ni de SQL", async () => {
    // Obtener los primeros 2 departamentos existentes de la base de datos
    const deptos = await prisma.departamento.findMany({
      where: { eliminadoEn: null },
      take: 2,
    });

    if (deptos.length >= 2) {
      const ids = [deptos[0].id, deptos[1].id];
      const resultado = await inspeccionesService.exportarFilasInspeccion({
        periodo: "todos",
        departamentosIds: ids,
        page: 1,
        limit: 10,
      });

      expect(resultado).toBeDefined();
      expect(Array.isArray(resultado.items)).toBe(true);
      expect(typeof resultado.total).toBe("number");
    }
  });
});

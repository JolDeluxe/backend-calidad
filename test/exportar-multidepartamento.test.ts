import { describe, it, expect } from "bun:test";
import {
  exportarInspeccionesQuerySchema,
  getInspeccionesQuerySchema,
  getPeriodosDisponiblesQuerySchema,
} from "../src/modules/inspecciones/inspecciones.schema";
import { inspeccionesService } from "../src/modules/inspecciones/services/inspecciones.service";
import { prisma } from "../src/config/database";
import { construirBloquesCsvExportacion } from "../../frontend/src/features/registro/utils/exportar-reporte";
import type { InspeccionFilaResponse } from "../../frontend/src/features/registro/types/registro.types";

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

  it("H-02: El contrato CSV mantiene permanentemente las 16 columnas fijas para departamentos mono-línea, multilínea y mixtos", () => {
    const filaMonoLinea: InspeccionFilaResponse = {
      id: 101,
      inspeccionId: 10,
      folio: "INSP-101",
      departamentoAuditoria: "CORTE",
      departamentoAuditoriaCodigo: "CORTE",
      fecha: "2026-11-19T14:00:00.000Z",
      lista: "15",
      lote: "50101",
      linea: "",
      modelo: "MOD-CORTE-01",
      descripcion: "BOTA VAQUERA",
      defectoId: 1,
      defectoClave: 101,
      defectoNombre: "RAYA EN PIEL",
      clasificacion: "MAYOR",
      defDepto: "CORTE",
      defDeptoCodigo: "CORTE",
      paresDefectuosos: 2,
      usuario: "JUAN PEREZ",
      usuarioLogin: "jperez",
      terminal: "PC-CORTE-01",
      lugarDeteccion: "CORTE",
      esDeptoExterno: false,
      nomenclatura: "DEFECTO DE CORTE ENCONTRADO EN CORTE",
      procedencia: "SISTEMA_NUEVO",
      estado: "RECHAZADO",
      eliminado: false,
      eliminadoEn: null,
      eliminadoPor: null,
      motivoEliminacion: null,
    };

    const filaMultiLinea: InspeccionFilaResponse = {
      ...filaMonoLinea,
      id: 102,
      inspeccionId: 11,
      folio: "INSP-102",
      departamentoAuditoria: "MONTADO",
      departamentoAuditoriaCodigo: "MONTADO",
      linea: "L2",
      modelo: "MOD-MONT-02",
      defDepto: "MONTADO",
      defDeptoCodigo: "MONTADO",
      usuario: "MARIA LOPEZ",
      lugarDeteccion: "MONTADO",
      nomenclatura: "DEFECTO DE MONTADO ENCONTRADO EN MONTADO",
    };

    // Caso A: Solo departamentos mono-línea (sin ninguna línea en los datos)
    const csvMono = construirBloquesCsvExportacion([filaMonoLinea]).join("").replace(/^\uFEFF/, "").trim().split("\r\n");
    const headersMono = csvMono[0].split(",");
    const camposFilaMono = csvMono[1].split(",");

    // 1. Exactamente 16 encabezados
    expect(headersMono.length).toBe(16);
    expect(headersMono[6]).toBe('"Línea"');
    expect(headersMono[7]).toBe('"Modelo"');
    expect(headersMono[13]).toBe('"Inspector"');
    expect(headersMono[14]).toBe('"Lugar de Detección"');
    expect(headersMono[15]).toBe('"Nomenclatura"');

    // 2. Exactamente 16 campos en cada fila
    expect(camposFilaMono.length).toBe(16);
    // 7. Valor vacío "" en Línea para departamentos mono-línea
    expect(camposFilaMono[6]).toBe('""');
    // 3. Posición correcta de Modelo (índice 7)
    expect(camposFilaMono[7]).toBe('"MOD-CORTE-01"');
    // 4. Posición correcta de Inspector (índice 13)
    expect(camposFilaMono[13]).toBe('"JUAN PEREZ"');
    // 5. Posición correcta de Lugar de Detección (índice 14)
    expect(camposFilaMono[14]).toBe('"CORTE"');
    // 6. Posición correcta de Nomenclatura (índice 15)
    expect(camposFilaMono[15]).toBe('"DEFECTO DE CORTE ENCONTRADO EN CORTE"');

    // Caso B: Exportación mixta (mono-línea + multilínea)
    const csvMixto = construirBloquesCsvExportacion([filaMonoLinea, filaMultiLinea]).join("").replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(csvMixto.length).toBe(3);
    const camposMixto1 = csvMixto[1].split(",");
    const camposMixto2 = csvMixto[2].split(",");
    expect(camposMixto1.length).toBe(16);
    expect(camposMixto2.length).toBe(16);
    expect(camposMixto1[6]).toBe('""');
    expect(camposMixto2[6]).toBe('"L2"');
    expect(camposMixto2[7]).toBe('"MOD-MONT-02"');
    expect(camposMixto2[13]).toBe('"MARIA LOPEZ"');
    expect(camposMixto2[14]).toBe('"MONTADO"');
    expect(camposMixto2[15]).toBe('"DEFECTO DE MONTADO ENCONTRADO EN MONTADO"');
  });

  it("H-03: Preserva y distingue departamentoResponsableId, departamentoAuditoriaId, departamentoId, departamentosIds y sus combinaciones", async () => {
    const deptos = await prisma.departamento.findMany({
      where: { eliminadoEn: null },
      take: 2,
    });
    expect(deptos.length).toBeGreaterThanOrEqual(2);
    const d1 = deptos[0].id;
    const d2 = deptos[1].id;

    // 1. Esquema acepta los 4 parámetros de forma independiente y combinada
    const parsedCombo = getInspeccionesQuerySchema.parse({
      periodo: "hoy",
      departamentoResponsableId: String(d1),
      departamentoAuditoriaId: String(d2),
      departamentosIds: `${d1},${d2}`,
    });
    expect(parsedCombo.departamentoResponsableId).toBe(d1);
    expect(parsedCombo.departamentoAuditoriaId).toBe(d2);
    expect(parsedCombo.departamentosIds).toEqual([d1, d2]);

    // 2. Consulta exclusiva por departamentoResponsableId
    const resResp = await inspeccionesService.getFilasInspeccion({
      periodo: "hoy",
      departamentoResponsableId: d1,
      page: 1,
      limit: 5,
    });
    expect(resResp).toBeDefined();
    for (const fila of resResp.items) {
      expect(fila.defDepto).toBe(deptos[0].nombre);
    }

    // 3. Consulta unificada por departamentoId (auditado OR responsable)
    const resUnificado = await inspeccionesService.getFilasInspeccion({
      periodo: "hoy",
      departamentoId: d1,
      page: 1,
      limit: 5,
    });
    expect(resUnificado).toBeDefined();
    for (const fila of resUnificado.items) {
      const coincide =
        fila.departamentoAuditoriaCodigo === deptos[0].codigo ||
        fila.defDepto === deptos[0].nombre;
      expect(coincide).toBe(true);
    }

    // 4. Combinación de departamentosIds con departamentoResponsableId
    const resCombinado = await inspeccionesService.getFilasInspeccion({
      periodo: "hoy",
      departamentosIds: [d1, d2],
      departamentoResponsableId: d1,
      page: 1,
      limit: 5,
    });
    expect(resCombinado).toBeDefined();
    for (const fila of resCombinado.items) {
      expect(fila.defDepto).toBe(deptos[0].nombre);
    }
  });
});

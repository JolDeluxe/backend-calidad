import { describe, expect, it } from "bun:test";
import {
  getIsoYearAndWeek,
  getMaxSemanasIsoEnAnio,
  getRangoSemanaIsoUtc,
} from "../src/utils/timezone";
import { inspeccionesService } from "../src/modules/inspecciones/services/inspecciones.service";

describe("Semanas operativas de Calidad (Miércoles a Martes)", () => {
  it("getRangoSemanaIsoUtc(2026, 47) genera del Miércoles 18 al Martes 24 nov. 2026", () => {
    const rango = getRangoSemanaIsoUtc(2026, 47);

    expect(rango.fechaInicio).toBe("2026-11-18"); // Miércoles
    expect(rango.fechaFin).toBe("2026-11-24");    // Martes
    expect(rango.inicioUtc.toISOString()).toBe("2026-11-18T06:00:00.000Z");
    expect(rango.finUtc.toISOString()).toBe("2026-11-25T06:00:00.000Z");
    expect(rango.label).toBe("del Miércoles 18 al Martes 24 (SEMANA 47)");
  });

  it("getIsoYearAndWeek agrupa correctamente fechas de Miércoles a Martes dentro de la misma semana", () => {
    // Semana 46: Miércoles 11 al Martes 17 nov. 2026
    expect(getIsoYearAndWeek("2026-11-11").semanaIso).toBe(46);
    expect(getIsoYearAndWeek("2026-11-17").semanaIso).toBe(46);

    // Corte y cambio a Semana 47: Miércoles 18 al Martes 24 nov. 2026
    expect(getIsoYearAndWeek("2026-11-18").semanaIso).toBe(47);
    expect(getIsoYearAndWeek("2026-11-19").semanaIso).toBe(47);
    expect(getIsoYearAndWeek("2026-11-20").semanaIso).toBe(47);
    expect(getIsoYearAndWeek("2026-11-21").semanaIso).toBe(47);
    expect(getIsoYearAndWeek("2026-11-22").semanaIso).toBe(47);
    expect(getIsoYearAndWeek("2026-11-23").semanaIso).toBe(47);
    expect(getIsoYearAndWeek("2026-11-24").semanaIso).toBe(47);

    // Corte y cambio a Semana 48: Miércoles 25 nov. 2026
    expect(getIsoYearAndWeek("2026-11-25").semanaIso).toBe(48);
  });

  it("resolverFiltroTemporalUtc resuelve semana 47 de Miércoles 00:00 local a Miércoles siguiente 00:00 local", () => {
    const res = inspeccionesService.resolverFiltroTemporalUtc({
      periodo: "semana",
      semana: 47,
      anioIso: 2026,
    });

    expect(res.periodoEfectivo).toBe("semana");
    expect(res.inicioUtc).toBeDefined();
    expect(res.finUtc).toBeDefined();
    expect(res.inicioUtc!.toISOString()).toBe("2026-11-18T06:00:00.000Z");
  });
});

import { describe, expect, it } from "bun:test";
import {
  getPartesFechaMexico,
  getRangoUltimosMesesUtc,
} from "../src/utils/timezone";
import { inspeccionesService } from "../src/modules/inspecciones/services/inspecciones.service";

describe("Filtro Recientes (periodo='ultimos') acotado a 6 meses", () => {
  it("getRangoUltimosMesesUtc(6) devuelve inicioUtc a 6 meses atrás y finUtc al fin de hoy en Mexico City", () => {
    const fixedNow = new Date("2026-11-18T18:00:00.000Z"); // 12:00 PM en Mexico (UTC-6)
    const { inicioUtc, finUtc } = getRangoUltimosMesesUtc(6, fixedNow);

    // Hoy en México: 2026-11-18
    // 6 meses atrás: 2026-05-18 a las 00:00:00 local (06:00:00 UTC)
    expect(inicioUtc.toISOString()).toBe("2026-05-18T06:00:00.000Z");

    // Fin de hoy: 2026-11-19 a las 00:00:00 local (06:00:00 UTC)
    expect(finUtc.toISOString()).toBe("2026-11-19T06:00:00.000Z");
  });

  it("resolverFiltroTemporalUtc asigna inicioUtc (6 meses) a la modalidad 'ultimos'", () => {
    const res = inspeccionesService.resolverFiltroTemporalUtc({ periodo: "ultimos" });
    expect(res.periodoEfectivo).toBe("ultimos");
    expect(res.inicioUtc).toBeDefined();
    expect(res.finUtc).toBeDefined();

    const partes = getPartesFechaMexico();
    // Validar que inicioUtc esté aproximadamente a 180 días / 6 meses atrás
    const diffDias = Math.round((res.finUtc!.getTime() - res.inicioUtc!.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDias).toBeGreaterThanOrEqual(180);
    expect(diffDias).toBeLessThanOrEqual(185);
  });

  it("getFilasInspeccion excluye registros anteriores a 6 meses en periodo='ultimos'", async () => {
    const res = await inspeccionesService.getFilasInspeccion({
      periodo: "ultimos",
      page: 1,
      limit: 30,
    });

    const { inicioUtc } = getRangoUltimosMesesUtc(6);
    expect(res.items.length).toBeGreaterThan(0);
    for (const item of res.items) {
      const fecha = new Date(item.fecha);
      expect(fecha.getTime()).toBeGreaterThanOrEqual(inicioUtc.getTime());
    }
  });
});

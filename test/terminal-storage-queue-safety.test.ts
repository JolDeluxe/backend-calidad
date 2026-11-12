import { describe, it, expect } from "bun:test";

interface MockColaItem {
  idLocalCliente: string;
  estado: "PENDIENTE" | "SINCRONIZANDO" | "ERROR_REINTENTABLE" | "REQUIERE_REVISION" | "SINCRONIZADA";
}

function evaluarSeguridadDesvinculacion(items: MockColaItem[]) {
  const pendientes = items.filter((i) => i.estado === "PENDIENTE").length;
  const sincronizando = items.filter((i) => i.estado === "SINCRONIZANDO").length;
  const erroresReintentables = items.filter((i) => i.estado === "ERROR_REINTENTABLE").length;
  const total = pendientes + sincronizando + erroresReintentables;

  if (total > 0) {
    return {
      puede: false,
      motivo: `No se puede desvincular: existen ${total} inspección(es) pendiente(s) en la cola local. Exporte un respaldo .mbcbak o complete la sincronización.`,
      pendientes: total,
    };
  }
  return { puede: true, pendientes: 0 };
}

describe("Blindaje: Reglas de Seguridad en Desvinculación de Estaciones Físicas", () => {
  it("1. Impide desvincular si hay inspecciones con estado PENDIENTE", () => {
    const cola: MockColaItem[] = [
      { idLocalCliente: "uuid-1", estado: "PENDIENTE" },
      { idLocalCliente: "uuid-2", estado: "SINCRONIZADA" },
    ];
    const resultado = evaluarSeguridadDesvinculacion(cola);
    expect(resultado.puede).toBe(false);
    expect(resultado.pendientes).toBe(1);
    expect(resultado.motivo).toContain("existen 1 inspección(es) pendiente(s)");
  });

  it("2. Impide desvincular si hay inspecciones con estado SINCRONIZANDO o ERROR_REINTENTABLE", () => {
    const cola: MockColaItem[] = [
      { idLocalCliente: "uuid-1", estado: "SINCRONIZANDO" },
      { idLocalCliente: "uuid-2", estado: "ERROR_REINTENTABLE" },
    ];
    const resultado = evaluarSeguridadDesvinculacion(cola);
    expect(resultado.puede).toBe(false);
    expect(resultado.pendientes).toBe(2);
  });

  it("3. Permite desvincular de forma segura si la cola está vacía o todo está SINCRONIZADA", () => {
    const cola: MockColaItem[] = [
      { idLocalCliente: "uuid-1", estado: "SINCRONIZADA" },
      { idLocalCliente: "uuid-2", estado: "SINCRONIZADA" },
    ];
    const resultado = evaluarSeguridadDesvinculacion(cola);
    expect(resultado.puede).toBe(true);
    expect(resultado.pendientes).toBe(0);
  });
});

import { describe, it, expect } from "bun:test";
import {
  CONSECUTIVO_AGOTADO,
  claveDe,
  esPrefijoValido,
  proyectarClaves,
  rangoDeGrupo,
  validarFilasLote,
} from "../src/modules/defectos/codificacion-claves";

// Pruebas unitarias puras: NO importan Prisma ni acceden a ninguna base de datos.

const rango = (desde: number, hasta: number): number[] =>
  Array.from({ length: hasta - desde + 1 }, (_, i) => desde + i);

describe("Codificación de claves por grupo (lógica pura)", () => {
  it("calcula clave y rango a partir del prefijo", () => {
    expect(claveDe(11, 1)).toBe(1101);
    expect(claveDe(18, 35)).toBe(1835);
    expect(rangoDeGrupo(21)).toEqual({ min: 2101, max: 2199 });
  });

  it("valida prefijos de dos dígitos", () => {
    expect(esPrefijoValido(11)).toBe(true);
    expect(esPrefijoValido(99)).toBe(true);
    expect(esPrefijoValido(9)).toBe(false);
    expect(esPrefijoValido(100)).toBe(false);
    expect(esPrefijoValido(11.5)).toBe(false);
  });

  it("CORTE (11) con 1101–1121 ocupadas propone 1122, 1123…", () => {
    const ocupadas = new Set(rango(1101, 1121));
    const r = proyectarClaves(11, 22, 3, ocupadas);
    expect(r.claves).toEqual([1122, 1123, 1124]);
    expect(r.omitidas).toEqual([]);
    expect(r.agotado).toBe(false);
    expect(r.siguienteConsecutivoResultante).toBe(25);
  });

  it("grupo nuevo (p. ej. prefijo 19 o 21) arranca en [prefijo]01", () => {
    expect(proyectarClaves(19, 1, 2, new Set()).claves).toEqual([1901, 1902]);
    expect(proyectarClaves(21, 1, 1, new Set()).claves).toEqual([2101]);
  });

  it("salta las claves anómalas históricas 1467–1469 y las reporta sin modificarlas", () => {
    const ocupadas = new Set([...rango(1401, 1442), 1467, 1468, 1469]);
    const r = proyectarClaves(14, 43, 30, ocupadas);
    expect(r.claves.slice(0, 24)).toEqual(rango(1443, 1466));
    expect(r.claves.slice(24)).toEqual(rango(1470, 1475));
    expect(r.omitidas).toEqual([1467, 1468, 1469]);
    expect(r.agotado).toBe(false);
  });

  it("no reutiliza claves ocupadas (incluidas las de defectos eliminados lógicamente)", () => {
    const ocupadas = new Set([1122]); // p. ej. eliminado lógicamente
    const r = proyectarClaves(11, 22, 2, ocupadas);
    expect(r.claves).toEqual([1123, 1124]);
    expect(r.omitidas).toEqual([1122]);
  });

  it("nunca desborda hacia el prefijo de otro grupo y marca agotado", () => {
    const r = proyectarClaves(18, 95, 10, new Set());
    expect(r.claves).toEqual([1895, 1896, 1897, 1898, 1899]);
    expect(r.agotado).toBe(true);
    expect(r.siguienteConsecutivoResultante).toBe(CONSECUTIVO_AGOTADO);
    expect(Math.max(...r.claves)).toBeLessThanOrEqual(1899);
  });

  it("un grupo ya agotado bloquea nuevas asignaciones", () => {
    const r = proyectarClaves(18, CONSECUTIVO_AGOTADO, 1, new Set());
    expect(r.claves).toEqual([]);
    expect(r.agotado).toBe(true);
  });

  it("la proyección es pura: no modifica el conjunto de claves ocupadas (la previsualización no reserva)", () => {
    const ocupadas = new Set([1101]);
    proyectarClaves(11, 1, 5, ocupadas);
    expect([...ocupadas]).toEqual([1101]);
  });

  it("cantidad cero conserva el consecutivo", () => {
    const r = proyectarClaves(11, 22, 0, new Set());
    expect(r.claves).toEqual([]);
    expect(r.agotado).toBe(false);
    expect(r.siguienteConsecutivoResultante).toBe(22);
  });
});

describe("Validación de filas de lote (lógica pura)", () => {
  it("detecta descripción vacía y clasificación inválida", () => {
    const r = validarFilasLote([
      { descripcion: "   ", clasificacion: "MAYOR" },
      { descripcion: "Costura floja", clasificacion: "GRAVE" },
      { descripcion: "Costura floja 2", clasificacion: "MENOR" },
    ]);
    expect(r[0].errores).toContain("La descripción es obligatoria");
    expect(r[1].errores).toContain("La clasificación debe ser CRITICO, MAYOR o MENOR");
    expect(r[2].errores).toEqual([]);
  });

  it("detecta duplicados dentro del listado ignorando mayúsculas, acentos y espacios", () => {
    const r = validarFilasLote([
      { descripcion: "Pliegue en costura", clasificacion: "MENOR" },
      { descripcion: "  PLIEGUE   en  costúra ", clasificacion: "MENOR" },
    ]);
    expect(r[0].errores).toEqual([]);
    expect(r[1].errores[0]).toContain("duplicada");
    expect(r[1].errores[0]).toContain("fila 1");
  });

  it("rechaza descripciones de más de 255 caracteres", () => {
    const r = validarFilasLote([{ descripcion: "x".repeat(256), clasificacion: "MENOR" }]);
    expect(r[0].errores.some((e) => e.includes("255"))).toBe(true);
  });
});

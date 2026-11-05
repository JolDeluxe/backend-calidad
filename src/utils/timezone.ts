/**
 * Utilidades de zona horaria e intervalos temporales para el Sistema de Calidad MBC.
 *
 * Zona horaria operativa oficial: `America/Mexico_City` (León, Guanajuato, México).
 * Desde la reforma de husos horarios en México (octubre 2022), `America/Mexico_City`
 * opera de forma permanente en UTC-6 (sin horario de verano).
 *
 * Todas las funciones de rango devuelven intervalos semiabiertos en UTC:
 *   [inicioUtc, finUtc)  =>  fecha >= inicioUtc && fecha < finUtc
 * evitando pérdidas de registros por milisegundos o desfases horarios en turnos vespertinos/nocturnos.
 */

export const TIMEZONE_OPERATIVA = "America/Mexico_City";
export const MEXICO_UTC_OFFSET_HOURS = 6;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export const NOMBRES_MESES_ES: Record<number, string> = {
  1: "Enero",
  2: "Febrero",
  3: "Marzo",
  4: "Abril",
  5: "Mayo",
  6: "Junio",
  7: "Julio",
  8: "Agosto",
  9: "Septiembre",
  10: "Octubre",
  11: "Noviembre",
  12: "Diciembre",
};

export const NOMBRES_MESES_CORTO_ES: Record<number, string> = {
  1: "ene.",
  2: "feb.",
  3: "mar.",
  4: "abr.",
  5: "may.",
  6: "jun.",
  7: "jul.",
  8: "ago.",
  9: "sep.",
  10: "oct.",
  11: "nov.",
  12: "dic.",
};

export const NOMBRES_DIAS_SEMANA_ES: Record<number, string> = {
  1: "Lunes",
  2: "Martes",
  3: "Miércoles",
  4: "Jueves",
  5: "Viernes",
  6: "Sábado",
  7: "Domingo",
};

/**
 * Valida que una cadena tenga formato estricto `AAAA-MM-DD` y corresponda a una fecha real del calendario
 * (rechazando fechas inexistentes como `2026-02-30` o `2026-13-01`).
 */
export function esFechaIsoValida(fechaStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr)) {
    return false;
  }
  const [y, m, d] = fechaStr.split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) {
    return false;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    !Number.isNaN(dt.getTime()) &&
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() + 1 === m &&
    dt.getUTCDate() === d
  );
}

/**
 * Convierte un instante `Date` (UTC) a sus componentes de calendario en `America/Mexico_City` (UTC-6).
 */
export function getPartesFechaMexico(date: Date = new Date()): {
  anio: number;
  mes: number;
  dia: number;
  diaSemanaIso: number; // 1 = Lunes .. 7 = Domingo
  fechaStr: string;     // AAAA-MM-DD
} {
  const localMs = date.getTime() - MEXICO_UTC_OFFSET_HOURS * MS_PER_HOUR;
  const localDate = new Date(localMs);
  const anio = localDate.getUTCFullYear();
  const mes = localDate.getUTCMonth() + 1;
  const dia = localDate.getUTCDate();
  const utcDay = localDate.getUTCDay();
  const diaSemanaIso = utcDay === 0 ? 7 : utcDay;
  const fechaStr = `${String(anio).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;

  return { anio, mes, dia, diaSemanaIso, fechaStr };
}

/**
 * Devuelve la fecha actual en `America/Mexico_City` en formato `AAAA-MM-DD`.
 */
export function getHoyMexicoStr(now: Date = new Date()): string {
  return getPartesFechaMexico(now).fechaStr;
}

/**
 * Calcula el intervalo semiabierto `[inicioUtc, finUtc)` en UTC para un día local `AAAA-MM-DD` en `America/Mexico_City`.
 * - `inicioUtc`: `AAAA-MM-DD 00:00:00.000` (America/Mexico_City) => `AAAA-MM-DDT06:00:00.000Z`
 * - `finUtc`:    `(AAAA-MM-DD + 1 día) 00:00:00.000` (America/Mexico_City) => `(AAAA-MM-DD+1)T06:00:00.000Z`
 */
export function getRangoDiaUtc(fechaStr: string): { inicioUtc: Date; finUtc: Date } {
  const [y, m, d] = fechaStr.split("-").map(Number);
  const inicioUtc = new Date(Date.UTC(y!, m! - 1, d!, MEXICO_UTC_OFFSET_HOURS, 0, 0, 0));
  const finUtc = new Date(Date.UTC(y!, m! - 1, d! + 1, MEXICO_UTC_OFFSET_HOURS, 0, 0, 0));
  return { inicioUtc, finUtc };
}

/**
 * Calcula el intervalo semiabierto `[inicioUtc, finUtc)` en UTC para un rango personalizado `[fechaDesde, fechaHasta]`
 * interpretado en `America/Mexico_City`.
 */
export function getRangoPersonalizadoUtc(
  fechaDesdeStr?: string,
  fechaHastaStr?: string
): { inicioUtc?: Date; finUtc?: Date } {
  const inicioUtc = fechaDesdeStr ? getRangoDiaUtc(fechaDesdeStr).inicioUtc : undefined;
  const finUtc = fechaHastaStr ? getRangoDiaUtc(fechaHastaStr).finUtc : undefined;
  return { inicioUtc, finUtc };
}

/**
 * Calcula el intervalo semiabierto `[inicioUtc, finUtc)` en UTC para un mes completo en `America/Mexico_City`.
 * - `inicioUtc`: Día 1 del mes a las 00:00:00.000 local (`06:00:00.000Z`).
 * - `finUtc`:    Día 1 del mes siguiente a las 00:00:00.000 local (`06:00:00.000Z`).
 */
export function getRangoMesUtc(anio: number, mes: number): { inicioUtc: Date; finUtc: Date } {
  const inicioUtc = new Date(Date.UTC(anio, mes - 1, 1, MEXICO_UTC_OFFSET_HOURS, 0, 0, 0));
  const finUtc = new Date(Date.UTC(anio, mes, 1, MEXICO_UTC_OFFSET_HOURS, 0, 0, 0));
  return { inicioUtc, finUtc };
}

/**
 * Calcula el intervalo semiabierto `[inicioUtc, finUtc)` en UTC para un año civil completo en `America/Mexico_City`.
 * - `inicioUtc`: 1 de enero de `anio` a las 00:00:00.000 local (`06:00:00.000Z`).
 * - `finUtc`:    1 de enero de `anio + 1` a las 00:00:00.000 local (`06:00:00.000Z`).
 */
export function getRangoAnioUtc(anio: number): { inicioUtc: Date; finUtc: Date } {
  const inicioUtc = new Date(Date.UTC(anio, 0, 1, MEXICO_UTC_OFFSET_HOURS, 0, 0, 0));
  const finUtc = new Date(Date.UTC(anio + 1, 0, 1, MEXICO_UTC_OFFSET_HOURS, 0, 0, 0));
  return { inicioUtc, finUtc };
}

/**
 * Calcula el Año ISO 8601 y el Número de Semana ISO 8601 (1..53, Lunes a Domingo)
 * para una fecha local `AAAA-MM-DD` (o `Date` convertida a `America/Mexico_City`).
 */
export function getIsoYearAndWeek(input: string | Date): {
  anioIso: number;
  semanaIso: number;
  yearWeek: number; // YYYYWW (idéntico a YEARWEEK(fecha, 3) en MySQL)
} {
  let y: number;
  let m: number;
  let d: number;

  if (typeof input === "string") {
    const parts = input.split("-").map(Number);
    y = parts[0]!;
    m = parts[1]!;
    d = parts[2]!;
  } else {
    const p = getPartesFechaMexico(input);
    y = p.anio;
    m = p.mes;
    d = p.dia;
  }

  const target = new Date(Date.UTC(y, m - 1, d));
  const dayNr = target.getUTCDay() === 0 ? 7 : target.getUTCDay(); // 1=Lunes .. 7=Domingo
  // Jueves de la misma semana ISO
  target.setUTCDate(target.getUTCDate() + 4 - dayNr);
  const anioIso = target.getUTCFullYear();
  const primerDiaAnioIso = new Date(Date.UTC(anioIso, 0, 1));
  const semanaIso = Math.ceil(((target.getTime() - primerDiaAnioIso.getTime()) / MS_PER_DAY + 1) / 7);

  return {
    anioIso,
    semanaIso,
    yearWeek: anioIso * 100 + semanaIso,
  };
}

/**
 * Obtiene el número total de semanas ISO (52 o 53) que posee un año ISO dado.
 */
export function getMaxSemanasIsoEnAnio(anioIso: number): number {
  // El 28 de diciembre siempre pertenece a la última semana ISO del año
  return getIsoYearAndWeek(`${anioIso}-12-28`).semanaIso;
}

/**
 * Calcula la información completa y el intervalo semiabierto `[inicioUtc, finUtc)` en UTC
 * para una semana ISO 8601 específica `(anioIso, semanaIso)` en `America/Mexico_City`.
 *
 * Maneja con exactitud las semanas que cruzan de un año civil a otro
 * (ej. Semana 01 de 2025: Lunes 30 dic. 2024 a Domingo 05 ene. 2025).
 */
export function getRangoSemanaIsoUtc(
  anioIso: number,
  semanaIso: number
): {
  anioIso: number;
  semanaIso: number;
  codigo: string;
  fechaInicio: string; // Lunes AAAA-MM-DD
  fechaFin: string;    // Domingo AAAA-MM-DD
  inicioUtc: Date;     // Lunes 00:00:00 America/Mexico_City en UTC
  finUtc: Date;        // Lunes siguiente 00:00:00 America/Mexico_City en UTC (intervalo semiabierto)
  label: string;
} {
  // El 4 de enero siempre cae en la Semana 1 del año ISO
  const ene4 = new Date(Date.UTC(anioIso, 0, 4));
  const diaSemEne4 = ene4.getUTCDay() === 0 ? 7 : ene4.getUTCDay(); // 1=Lunes .. 7=Domingo

  // Lunes de la Semana 1 de anioIso (a las 00:00 UTC puro para aritmética de calendario)
  const lunesSem1 = new Date(Date.UTC(anioIso, 0, 4 - (diaSemEne4 - 1)));

  // Lunes de la semana solicitada
  const lunesTarget = new Date(lunesSem1.getTime() + (semanaIso - 1) * 7 * MS_PER_DAY);
  // Domingo de la semana solicitada (+6 días)
  const domingoTarget = new Date(lunesTarget.getTime() + 6 * MS_PER_DAY);

  const y1 = lunesTarget.getUTCFullYear();
  const m1 = lunesTarget.getUTCMonth() + 1;
  const d1 = lunesTarget.getUTCDate();

  const y2 = domingoTarget.getUTCFullYear();
  const m2 = domingoTarget.getUTCMonth() + 1;
  const d2 = domingoTarget.getUTCDate();

  const fechaInicio = `${String(y1).padStart(4, "0")}-${String(m1).padStart(2, "0")}-${String(d1).padStart(2, "0")}`;
  const fechaFin = `${String(y2).padStart(4, "0")}-${String(m2).padStart(2, "0")}-${String(d2).padStart(2, "0")}`;

  const inicioUtc = new Date(Date.UTC(y1, m1 - 1, d1, MEXICO_UTC_OFFSET_HOURS, 0, 0, 0));
  const finUtc = new Date(Date.UTC(y1, m1 - 1, d1 + 7, MEXICO_UTC_OFFSET_HOURS, 0, 0, 0));

  const semanaPad = String(semanaIso).padStart(2, "0");
  const codigo = `${anioIso}-W${semanaPad}`;

  const mesCorto1 = NOMBRES_MESES_CORTO_ES[m1] || "";
  const mesCorto2 = NOMBRES_MESES_CORTO_ES[m2] || "";

  // Si la semana cruza de año civil (ej. 30 dic. 2024 – 05 ene. 2025), mostrar ambos años explícitamente
  const rangoTexto =
    y1 !== y2
      ? `${d1} ${mesCorto1} ${y1} – ${d2} ${mesCorto2} ${y2}`
      : m1 !== m2
      ? `${d1} ${mesCorto1} – ${d2} ${mesCorto2} ${y2}`
      : `${d1} – ${d2} ${mesCorto2} ${y2}`;

  const label = `Semana ${semanaPad} (${rangoTexto})`;

  return {
    anioIso,
    semanaIso,
    codigo,
    fechaInicio,
    fechaFin,
    inicioUtc,
    finUtc,
    label,
  };
}

/**
 * Calcula el intervalo semiabierto `[inicioUtc, finUtc)` en UTC que abarca todas las semanas ISO
 * pertenecientes a un `anioIso` completo (desde el Lunes de la Semana 1 de `anioIso` hasta el
 * Lunes de la Semana 1 de `anioIso + 1`).
 */
export function getRangoAnioIsoCompletoUtc(anioIso: number): { inicioUtc: Date; finUtc: Date } {
  const sem1Actual = getRangoSemanaIsoUtc(anioIso, 1);
  const sem1Siguiente = getRangoSemanaIsoUtc(anioIso + 1, 1);
  return {
    inicioUtc: sem1Actual.inicioUtc,
    finUtc: sem1Siguiente.inicioUtc,
  };
}

/**
 * Formatea una fecha `AAAA-MM-DD` a formato legible `DD/MM/AAAA` y obtiene el nombre del día en español.
 */
export function formatearDiaDisponible(fechaStr: string): {
  fecha: string;
  dia: number;
  mes: number;
  anio: number;
  nombreDia: string;
  label: string;
} {
  const [anio, mes, dia] = fechaStr.split("-").map(Number);
  const dt = new Date(Date.UTC(anio!, mes! - 1, dia!));
  const utcDay = dt.getUTCDay();
  const diaSemIso = utcDay === 0 ? 7 : utcDay;
  const nombreDia = NOMBRES_DIAS_SEMANA_ES[diaSemIso] || "";
  const label = `${String(dia).padStart(2, "0")}/${String(mes).padStart(2, "0")}/${anio}`;

  return {
    fecha: fechaStr,
    dia: dia!,
    mes: mes!,
    anio: anio!,
    nombreDia,
    label,
  };
}

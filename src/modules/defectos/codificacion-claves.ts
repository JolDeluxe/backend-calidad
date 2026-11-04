/**
 * Lógica pura (sin acceso a base de datos) de codificación de claves de defecto.
 *
 * Esquema histórico: clave = prefijo (2 dígitos) * 100 + consecutivo (01..99).
 * Cada grupo (línea + departamento propietario) tiene su propio prefijo.
 */

export const PREFIJO_MIN = 10;
export const PREFIJO_MAX = 99;
export const CONSECUTIVO_MIN = 1;
export const CONSECUTIVO_MAX = 99;
/** Valor de `siguienteConsecutivo` que indica que el grupo agotó su rango. */
export const CONSECUTIVO_AGOTADO = CONSECUTIVO_MAX + 1;

export const MAX_FILAS_LOTE = 200;
export const MAX_LONGITUD_DESCRIPCION = 255;
export const CLASIFICACIONES_DEFECTO = ["CRITICO", "MAYOR", "MENOR"] as const;

export function esPrefijoValido(prefijo: number): boolean {
  return Number.isInteger(prefijo) && prefijo >= PREFIJO_MIN && prefijo <= PREFIJO_MAX;
}

export function claveDe(prefijo: number, consecutivo: number): number {
  return prefijo * 100 + consecutivo;
}

export function rangoDeGrupo(prefijo: number): { min: number; max: number } {
  return { min: claveDe(prefijo, CONSECUTIVO_MIN), max: claveDe(prefijo, CONSECUTIVO_MAX) };
}

export interface ProyeccionClaves {
  /** Claves libres asignables, en orden ascendente (puede tener menos de las solicitadas si el grupo se agota). */
  claves: number[];
  /** Claves del rango ya ocupadas (activas o eliminadas lógicamente) que se saltaron. */
  omitidas: number[];
  /** true si no hay suficientes claves libres dentro del rango del grupo. */
  agotado: boolean;
  /** Valor que debe quedar en `siguienteConsecutivo` tras consumir `claves` (100 = agotado). */
  siguienteConsecutivoResultante: number;
}

/**
 * Calcula las próximas `cantidad` claves libres de un grupo sin salirse nunca de su rango 01–99
 * y saltando cualquier clave ya ocupada (incluidas las de defectos eliminados lógicamente y las anómalas históricas).
 */
export function proyectarClaves(
  prefijo: number,
  siguienteConsecutivo: number,
  cantidad: number,
  clavesOcupadas: ReadonlySet<number>,
): ProyeccionClaves {
  const claves: number[] = [];
  const omitidas: number[] = [];
  let siguiente = Math.max(CONSECUTIVO_MIN, siguienteConsecutivo);

  while (claves.length < cantidad && siguiente <= CONSECUTIVO_MAX) {
    const clave = claveDe(prefijo, siguiente);
    if (clavesOcupadas.has(clave)) {
      omitidas.push(clave);
    } else {
      claves.push(clave);
    }
    siguiente += 1;
  }

  return {
    claves,
    omitidas,
    agotado: claves.length < cantidad,
    siguienteConsecutivoResultante: Math.min(siguiente, CONSECUTIVO_AGOTADO),
  };
}

export interface FilaLoteEntrada {
  clave?: number;
  descripcion: string;
  clasificacion: string;
}

export interface ResultadoValidacionFila {
  indice: number;
  errores: string[];
}

function normalizarDescripcion(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Valida cada fila del lote: descripción obligatoria y acotada, clasificación válida, clave si se envía y duplicados dentro del listado.
 * No consulta la base de datos.
 */
export function validarFilasLote(filas: ReadonlyArray<FilaLoteEntrada>): ResultadoValidacionFila[] {
  const primeraAparicion = new Map<string, number>();
  const primeraClave = new Map<number, number>();

  return filas.map((fila, indice) => {
    const errores: string[] = [];
    const descripcion = (fila.descripcion ?? "").trim();

    if (fila.clave !== undefined) {
      if (!Number.isInteger(fila.clave) || fila.clave <= 0) {
        errores.push("La clave debe ser un número entero positivo");
      } else {
        const previa = primeraClave.get(fila.clave);
        if (previa !== undefined) {
          errores.push(`Clave duplicada en el listado (igual a la fila ${previa + 1})`);
        } else {
          primeraClave.set(fila.clave, indice);
        }
      }
    }

    if (descripcion.length === 0) {
      errores.push("La descripción es obligatoria");
    } else {
      if (descripcion.length > MAX_LONGITUD_DESCRIPCION) {
        errores.push(`La descripción no debe exceder ${MAX_LONGITUD_DESCRIPCION} caracteres`);
      }
      const normalizada = normalizarDescripcion(descripcion);
      const previa = primeraAparicion.get(normalizada);
      if (previa !== undefined) {
        errores.push(`Descripción duplicada en el listado (igual a la fila ${previa + 1})`);
      } else {
        primeraAparicion.set(normalizada, indice);
      }
    }

    if (!(CLASIFICACIONES_DEFECTO as readonly string[]).includes(fila.clasificacion)) {
      errores.push("La clasificación debe ser CRITICO, MAYOR o MENOR");
    }

    return { indice, errores };
  });
}

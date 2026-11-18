export interface TerminalDepartamentoSnapshotItem {
  departamentoId: number;
  codigo: string;
  nombre: string;
  esPrincipal: boolean;
}

export interface CalcularLugarDeteccionParams {
  terminalNombre: string;
  departamentoPrincipalNombre?: string;
  departamentosActivos: Array<{
    departamentoId: number;
    codigo?: string;
    nombre: string;
    esPrincipal?: boolean;
  }>;
}

export interface ClasificarDefectoTerminalParams extends CalcularLugarDeteccionParams {
  defectoDepartamentoId: number;
  defectoDepartamentoNombre: string;
}

export interface ClasificacionDefectoTerminalResult {
  departamentoPropietarioId: number;
  departamentoPropietarioNombre: string;
  lugarDeteccionTexto: string;
  esDeptoExterno: boolean;
  nomenclaturaTexto: string;
}

/**
 * Determina el nombre del lugar de detección general de la terminal
 * (usado a nivel de cabecera de inspección):
 * - Si la terminal tiene exactamente 1 departamento activo asociado: nombre de ese departamento.
 * - Si la terminal tiene 2 o más departamentos activos asociados: nombre visible de la terminal (ej. SIGMA).
 */
export function resolverLugarDeteccionTerminal(params: CalcularLugarDeteccionParams): string {
  const activos = (params.departamentosActivos || []).filter(
    (d) => d && typeof d.nombre === "string" && d.nombre.trim().length > 0
  );

  if (activos.length === 1) {
    return activos[0].nombre.trim();
  }

  if (activos.length >= 2) {
    return params.terminalNombre.trim();
  }

  // Fallback para registros donde solo se conoce el departamento principal o nombre de terminal
  return (params.departamentoPrincipalNombre || params.terminalNombre || "").trim();
}

/**
 * Determina el lugar de detección específico para un defecto capturado en la terminal:
 * 1. Si el defecto pertenece a uno de los departamentos activos de la terminal (defecto propio):
 *    -> El lugar de detección es exactamente ese departamento (ej. PRELIMINARES o BORDADO Y LÁSER).
 *    -> esDeptoExterno = false.
 * 2. Si el defecto NO pertenece a los departamentos de la terminal (defecto externo):
 *    -> Si la terminal tiene exactamente 1 departamento activo: nombre de ese departamento.
 *    -> Si la terminal tiene 2 o más departamentos activos (estación compartida): nombre personalizado
 *       de la terminal (ej. SIGMA) para no adivinar cuál de los departamentos lo detectó.
 *    -> esDeptoExterno = true.
 */
export function resolverLugarDeteccionDefecto(
  params: ClasificarDefectoTerminalParams
): { lugarDeteccionTexto: string; esDeptoExterno: boolean } {
  const activos = (params.departamentosActivos || []).filter(
    (d) => d && typeof d.nombre === "string" && d.nombre.trim().length > 0
  );
  const activosIds = new Set(activos.map((d) => Number(d.departamentoId)));
  const defDeptoId = Number(params.defectoDepartamentoId);

  // ¿El defecto pertenece a uno de los departamentos activos de la terminal?
  const esPropio = activosIds.has(defDeptoId);

  if (esPropio) {
    const deptoEncontrado = activos.find((d) => Number(d.departamentoId) === defDeptoId);
    return {
      lugarDeteccionTexto: (deptoEncontrado?.nombre || params.defectoDepartamentoNombre).trim(),
      esDeptoExterno: false,
    };
  }

  // Defecto externo a la terminal:
  let lugarExterno: string;
  if (activos.length === 1) {
    lugarExterno = activos[0].nombre.trim();
  } else if (activos.length >= 2) {
    lugarExterno = params.terminalNombre.trim();
  } else {
    lugarExterno = (params.departamentoPrincipalNombre || params.terminalNombre || "").trim();
  }

  return {
    lugarDeteccionTexto: lugarExterno,
    esDeptoExterno: true,
  };
}

/**
 * Construye la descripción reglamentaria:
 * `DEFECTO DE {DEPARTAMENTO_PROPIETARIO} ENCONTRADO EN {LUGAR_DE_DETECCION}`
 */
export function construirNomenclaturaDefecto(
  departamentoPropietarioNombre: string,
  lugarDeteccionTexto: string
): string {
  const propietario = departamentoPropietarioNombre.trim().toUpperCase();
  const lugar = lugarDeteccionTexto.trim().toUpperCase();
  return `DEFECTO DE ${propietario} ENCONTRADO EN ${lugar}`;
}

/**
 * Evalúa integralmente un defecto capturado en una terminal (individual o compartida):
 * 1. Conserva `Defecto.departamentoId` como departamento propietario inmutable.
 * 2. Calcula `lugarDeteccionTexto` y `esDeptoExterno` según pertenencia a la terminal.
 * 3. Construye `nomenclaturaTexto`.
 */
export function clasificarDefectoEnTerminal(
  params: ClasificarDefectoTerminalParams
): ClasificacionDefectoTerminalResult {
  const { lugarDeteccionTexto, esDeptoExterno } = resolverLugarDeteccionDefecto(params);
  const deptoPropietarioNombre = params.defectoDepartamentoNombre.trim();

  const nomenclaturaTexto = construirNomenclaturaDefecto(
    deptoPropietarioNombre,
    lugarDeteccionTexto
  );

  return {
    departamentoPropietarioId: Number(params.defectoDepartamentoId),
    departamentoPropietarioNombre: deptoPropietarioNombre,
    lugarDeteccionTexto,
    esDeptoExterno,
    nomenclaturaTexto,
  };
}

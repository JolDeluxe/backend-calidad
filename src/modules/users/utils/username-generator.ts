import { prisma } from "../../../config/database";

/** Partículas y preposiciones patronímicas en español */
const PARTICULAS_APELLIDO = new Set([
  "de",
  "del",
  "de la",
  "de las",
  "de los",
  "san",
  "santa",
  "van",
  "von",
  "la",
  "las",
  "los",
]);

/**
 * Limpia diacríticos y caracteres no alfanuméricos.
 */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remueve acentos
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

/**
 * Agrupa partículas patronímicas para no separar apellidos como "de la Rosa" o "Montes de Oca".
 */
export function segmentarNombreYApellidos(nombreCompleto: string): {
  primerNombre: string;
  apellidos: string[];
} {
  const limpio = normalizarTexto(nombreCompleto);
  const tokens = limpio.split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return { primerNombre: "usuario", apellidos: [] };
  }

  const primerNombre = tokens[0];
  const restoTokens = tokens.slice(1);

  const apellidos: string[] = [];
  let i = 0;

  while (i < restoTokens.length) {
    // Verificar si los siguientes 2 tokens forman "de la", "de los", "de las"
    if (
      i + 2 < restoTokens.length &&
      (restoTokens[i] === "de" || restoTokens[i] === "del") &&
      (restoTokens[i + 1] === "la" || restoTokens[i + 1] === "los" || restoTokens[i + 1] === "las")
    ) {
      const apellidoCompuesto = `${restoTokens[i]}${restoTokens[i + 1]}${restoTokens[i + 2]}`;
      apellidos.push(apellidoCompuesto);
      i += 3;
      continue;
    }

    // Verificar si el token actual es partícula como "de", "del", "san", "santa"
    if (i + 1 < restoTokens.length && PARTICULAS_APELLIDO.has(restoTokens[i])) {
      const apellidoCompuesto = `${restoTokens[i]}${restoTokens[i + 1]}`;
      // Si a su vez el que sigue tiene "de" como "Montes de Oca"
      if (i + 3 < restoTokens.length && restoTokens[i + 2] === "de") {
        apellidos.push(`${apellidoCompuesto}de${restoTokens[i + 3]}`);
        i += 4;
        continue;
      }
      apellidos.push(apellidoCompuesto);
      i += 2;
      continue;
    }

    // Caso común: token con posible sufijo "de oca" inmediato
    if (i + 2 < restoTokens.length && restoTokens[i + 1] === "de") {
      apellidos.push(`${restoTokens[i]}de${restoTokens[i + 2]}`);
      i += 3;
      continue;
    }

    // Caso token simple
    apellidos.push(restoTokens[i]);
    i += 1;
  }

  return { primerNombre, apellidos };
}

/**
 * Genera una sugerencia base y valida unicidad contra la base de datos de usuarios.
 */
export async function generarUsernameUnico(
  nombreCompleto: string,
  usuarioIdExcluir?: number
): Promise<string> {
  const { primerNombre, apellidos } = segmentarNombreYApellidos(nombreCompleto);

  // Candidato 1: primernombre + primerapellido
  // Candidato 2: primernombre + primerapellido + segundoapellido
  const primerApellido = apellidos[0] || "";
  const segundoApellido = apellidos[1] || "";

  const base1 = (primerNombre + primerApellido).replace(/[^a-z0-9]/g, "");
  const base2 = (primerNombre + primerApellido + segundoApellido).replace(/[^a-z0-9]/g, "");

  const candidatoBase = base1 || primerNombre || "usuario";

  // Función para verificar si un username ya existe en la BD
  async function existeUsername(u: string): Promise<boolean> {
    const usuarioExistente = await prisma.usuario.findUnique({
      where: { usuario: u },
      select: { id: true },
    });
    if (!usuarioExistente) return false;
    if (usuarioIdExcluir && usuarioExistente.id === usuarioIdExcluir) return false;
    return true;
  }

  if (!(await existeUsername(candidatoBase))) {
    return candidatoBase;
  }

  // Si colisiona y tenemos segundo apellido, probamos con base2
  if (base2 && base2 !== candidatoBase && !(await existeUsername(base2))) {
    return base2;
  }

  // Si colisiona, agregamos sufijo numérico secuencial
  let contador = 2;
  while (await existeUsername(`${candidatoBase}${contador}`)) {
    contador += 1;
  }

  return `${candidatoBase}${contador}`;
}

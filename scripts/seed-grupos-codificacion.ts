/**
 * Configura los grupos de codificación de defectos con reglas CONFIRMADAS (BOTA 11–18).
 *
 * - Por defecto es DRY-RUN: solo lee, no escribe nada.
 * - Con `--apply` crea únicamente los grupos que NO existan (nunca modifica grupos existentes
 *   ni toca la tabla de defectos).
 * - No inventa prefijos: cualquier combinación línea/departamento sin regla confirmada se lista como PENDIENTE.
 *
 * Uso:  bun run scripts/seed-grupos-codificacion.ts            (dry-run)
 *       bun run scripts/seed-grupos-codificacion.ts --apply    (escribe, requiere la migración aplicada)
 */
import { prisma } from "../src/config/database";
import { CONSECUTIVO_AGOTADO, claveDe, rangoDeGrupo } from "../src/modules/defectos/codificacion-claves";

// Reglas confirmadas con Catalogo_Def.txt (rangos 11xx–18xx de la línea BOTA).
const REGLAS_CONFIRMADAS: Record<string, Record<string, number>> = {
  BOTA: {
    CORTE: 11,
    PRELIMINARES: 12,
    BORDADO_LASER: 13,
    PESPUNTE: 14,
    MONTADO: 15,
    AVIOS: 16,
    ACABADO: 17,
    ADORNO: 18,
  },
};

async function main() {
  const apply = process.argv.includes("--apply");
  const dbName = (process.env.DATABASE_URL ?? "").split("?")[0].split("/").pop();
  console.log(`Modo: ${apply ? "APPLY (escritura)" : "DRY-RUN (solo lectura)"} | Base de datos destino: ${dbName}`);

  const asignaciones = await prisma.departamentoLinea.findMany({
    where: { activo: true, eliminadoEn: null },
    include: { linea: true, departamento: true },
    orderBy: [{ lineaId: "asc" }, { orden: "asc" }],
  });

  const pendientes: string[] = [];
  const aCrear: Array<{ lineaId: number; departamentoId: number; prefijo: number; siguiente: number; etiqueta: string }> = [];

  for (const a of asignaciones) {
    const etiqueta = `${a.linea.codigo}/${a.departamento.codigo}`;
    const prefijo = REGLAS_CONFIRMADAS[a.linea.codigo]?.[a.departamento.codigo];
    if (prefijo === undefined) {
      pendientes.push(etiqueta);
      continue;
    }

    // El siguiente consecutivo parte del máximo existente DENTRO del rango y propiedad del departamento.
    // Las claves anómalas fuera de rango (p. ej. 16001, 1467–1469) no se tocan ni influyen.
    const { min, max } = rangoDeGrupo(prefijo);
    const maxProp = await prisma.defecto.aggregate({
      _max: { clave: true },
      where: { departamentoId: a.departamentoId, clave: { gte: min, lte: max } },
    });
    const siguiente = maxProp._max.clave ? Math.min(maxProp._max.clave - prefijo * 100 + 1, CONSECUTIVO_AGOTADO) : 1;
    aCrear.push({ lineaId: a.lineaId, departamentoId: a.departamentoId, prefijo, siguiente, etiqueta });
  }

  console.log("\nGrupos con regla confirmada:");
  for (const g of aCrear) {
    console.log(`  ${g.etiqueta}: prefijo ${g.prefijo} -> siguiente clave ${claveDe(g.prefijo, Math.min(g.siguiente, 99))}`);
  }
  console.log("\nGrupos PENDIENTES de configuración (sin regla confirmada):");
  pendientes.forEach((p) => console.log(`  ${p}`));

  if (!apply) {
    console.log("\nDRY-RUN: no se escribió nada. Use --apply tras aplicar la migración y confirmar el destino.");
    return;
  }

  let creados = 0;
  let omitidos = 0;
  for (const g of aCrear) {
    const existente = await prisma.grupoCodificacionDefecto.findUnique({
      where: { unique_grupo_linea_depto: { lineaId: g.lineaId, departamentoId: g.departamentoId } },
    });
    if (existente) {
      omitidos++;
      continue;
    }
    await prisma.grupoCodificacionDefecto.create({
      data: {
        lineaId: g.lineaId,
        departamentoId: g.departamentoId,
        prefijo: g.prefijo,
        siguienteConsecutivo: g.siguiente,
        activo: true,
      },
    });
    creados++;
  }
  console.log(`\nGrupos creados: ${creados} | ya existentes (sin cambios): ${omitidos}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

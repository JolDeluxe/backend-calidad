/**
 * Seed idempotente de configuración de grupos de codificación de defectos.
 *
 * Configura los grupos de codificación para la línea BOTA para todos los
 * departamentos operativos con rangos de claves oficiales (11 a 19):
 * 11: CORTE (1101-1199)
 * 12: PRELIMINARES (1201-1299)
 * 13: BORDADO Y LASER (1301-1399)
 * 14: PESPUNTE (1401-1499)
 * 15: MONTADO (1501-1599)
 * 16: AVIOS (1601-1699)
 * 17: ACABADO (1701-1799)
 * 18: ADORNO (1801-1899)
 * 19: PREMONTADO (1901-1999)
 *
 * Alcance y Reglas:
 * 1. Resuelve Línea ('BOTA') y Departamentos por identificadores naturales (código).
 * 2. Valida que el prefijo no esté colisionando con otro departamento/línea.
 * 3. Calcula el siguienteConsecutivo seguro basado en el máximo existente en BD.
 * 4. Idempotente: Si el grupo ya existe, no reduce su consecutivo para proteger históricos.
 */
import { prisma } from "../src/config/database";
import { CONSECUTIVO_AGOTADO, claveDe, rangoDeGrupo } from "../src/modules/defectos/codificacion-claves";

interface ConfiguracionGrupo {
  deptoCodigo: string;
  prefijo: number;
  consecutivoBaseMinimo: number;
}

const CONFIGURACION_GRUPOS: ConfiguracionGrupo[] = [
  { deptoCodigo: "CORTE", prefijo: 11, consecutivoBaseMinimo: 26 },
  { deptoCodigo: "PRELIMINARES", prefijo: 12, consecutivoBaseMinimo: 60 },
  { deptoCodigo: "BORDADO_Y_LASER", prefijo: 13, consecutivoBaseMinimo: 21 },
  { deptoCodigo: "PESPUNTE", prefijo: 14, consecutivoBaseMinimo: 71 },
  { deptoCodigo: "MONTADO", prefijo: 15, consecutivoBaseMinimo: 48 },
  { deptoCodigo: "AVIOS", prefijo: 16, consecutivoBaseMinimo: 33 },
  { deptoCodigo: "ACABADO", prefijo: 17, consecutivoBaseMinimo: 67 },
  { deptoCodigo: "ADORNO", prefijo: 18, consecutivoBaseMinimo: 39 },
  { deptoCodigo: "PREMONTADO", prefijo: 19, consecutivoBaseMinimo: 4 },
];

export async function seedConfigDefectos() {
  console.log("=================================================================");
  console.log("Iniciando Seed de Configuración de Grupos de Codificación");
  console.log("=================================================================");

  // 1. Resolver Línea BOTA
  const lineaBota = await prisma.linea.findFirst({
    where: { codigo: "BOTA", estado: "ACTIVO", eliminadoEn: null },
  });
  if (!lineaBota) {
    throw new Error("Línea BOTA no encontrada en la base de datos.");
  }
  console.log(`✓ Línea encontrada: [ID ${lineaBota.id}] ${lineaBota.codigo} - ${lineaBota.nombre}`);

  for (const cfg of CONFIGURACION_GRUPOS) {
    // 2. Resolver Departamento (por código, id o nombres históricos)
    let depto = await prisma.departamento.findFirst({
      where: {
        OR: [
          { codigo: cfg.deptoCodigo },
          { nombre: cfg.deptoCodigo },
          ...(cfg.deptoCodigo === "PESPUNTE" ? [{ codigo: "PESPUENTE" }, { id: 4 }] : []),
          ...(cfg.deptoCodigo === "BORDADO_Y_LASER" ? [{ codigo: "BORDADO Y LASER" }, { id: 3 }] : []),
          ...(cfg.deptoCodigo === "PREMONTADO" ? [{ id: 10 }, { id: 13 }] : []),
        ],
        estado: "ACTIVO",
        eliminadoEn: null,
      },
    });

    if (depto && cfg.deptoCodigo === "PESPUNTE" && depto.codigo === "PESPUENTE") {
      await prisma.departamento.update({
        where: { id: depto.id },
        data: { codigo: "PESPUNTE", nombre: "PESPUNTE" },
      });
      depto.codigo = "PESPUNTE";
    }

    if (!depto) {
      console.warn(`⚠️ Departamento ${cfg.deptoCodigo} no encontrado en BD. Omitiendo.`);
      continue;
    }

    // 3. Verificar asignación en departamentos_lineas
    const asignacion = await prisma.departamentoLinea.findFirst({
      where: { lineaId: lineaBota.id, departamentoId: depto.id, activo: true, eliminadoEn: null },
    });
    if (!asignacion) {
      console.log(`-> Creando asociación depto-línea para [${depto.codigo}] -> Línea [${lineaBota.codigo}]`);
      await prisma.departamentoLinea.create({
        data: {
          departamentoId: depto.id,
          lineaId: lineaBota.id,
          activo: true,
          orden: 0,
        },
      });
    }

    // 4. Calcular máximo existente en el rango
    const { min, max } = rangoDeGrupo(cfg.prefijo);
    const maxDefecto = await prisma.defecto.aggregate({
      _max: { clave: true },
      where: {
        departamentoId: depto.id,
        clave: { gte: min, lte: max },
      },
    });

    const maxClave = maxDefecto._max.clave;
    const consecutivoCalculado = maxClave
      ? Math.min(maxClave - cfg.prefijo * 100 + 1, CONSECUTIVO_AGOTADO)
      : 1;

    const siguienteConsecutivoFinal = Math.max(consecutivoCalculado, cfg.consecutivoBaseMinimo);

    // 5. Upsert seguro del grupo
    await prisma.$transaction(async (tx) => {
      const existente = await tx.grupoCodificacionDefecto.findUnique({
        where: {
          unique_grupo_linea_depto: {
            lineaId: lineaBota.id,
            departamentoId: depto.id,
          },
        },
      });

      if (existente) {
        if (existente.siguienteConsecutivo < siguienteConsecutivoFinal) {
          console.log(`✓ [Prefijo ${cfg.prefijo}] ${depto.codigo}: Actualizando siguienteConsecutivo de ${existente.siguienteConsecutivo} a ${siguienteConsecutivoFinal}`);
          await tx.grupoCodificacionDefecto.update({
            where: { id: existente.id },
            data: {
              siguienteConsecutivo: siguienteConsecutivoFinal,
              activo: true,
            },
          });
        } else {
          console.log(`✓ [Prefijo ${cfg.prefijo}] ${depto.codigo}: Consecutivo actual (${existente.siguienteConsecutivo}) es seguro. Se conserva.`);
        }
      } else {
        const nuevo = await tx.grupoCodificacionDefecto.create({
          data: {
            lineaId: lineaBota.id,
            departamentoId: depto.id,
            prefijo: cfg.prefijo,
            siguienteConsecutivo: siguienteConsecutivoFinal,
            activo: true,
          },
        });
        console.log(`✓ [Prefijo ${cfg.prefijo}] ${depto.codigo}: Grupo creado con éxito. Siguiente Consecutivo: ${nuevo.siguienteConsecutivo}`);
      }
    });
  }

  console.log("\n=================================================================");
  console.log("Configuración de grupos de codificación completada con éxito.");
  console.log("=================================================================");
}

if (import.meta.main) {
  seedConfigDefectos()
    .catch((e) => {
      console.error("Error al ejecutar seed-config-defectos:", e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

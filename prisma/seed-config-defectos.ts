/**
 * Seed idempotente de configuración de grupos de codificación de defectos.
 *
 * Alcance y Reglas:
 * 1. Resuelve Línea ('BOTA') y Departamento ('ADORNO') por identificadores naturales (código).
 * 2. Valida que el prefijo 18 no esté utilizado por otro grupo en otra combinación.
 * 3. Comprueba claves históricas de ADORNO (mínimo 36 para asegurar consecutivo seguro).
 * 4. Idempotente: Si el grupo ya existe, no lo duplica ni reduce su consecutivo.
 * 5. Ejecuta las mutaciones dentro de una transacción.
 * 6. Reporta de manera transparente y detallada qué se crea y qué se conserva.
 * 7. Excluye explícitamente ACCESORIO (prefijos pendientes) y BETA 7 (sin codificación de defectos).
 */
import { prisma } from "../src/config/database";
import { CONSECUTIVO_AGOTADO, claveDe, rangoDeGrupo } from "../src/modules/defectos/codificacion-claves";

async function main() {
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

  // 2. Resolver Departamento ADORNO
  const deptoAdorno = await prisma.departamento.findFirst({
    where: { codigo: "ADORNO", estado: "ACTIVO", eliminadoEn: null },
  });
  if (!deptoAdorno) {
    throw new Error("Departamento ADORNO no encontrado en la base de datos.");
  }
  console.log(`✓ Departamento encontrado: [ID ${deptoAdorno.id}] ${deptoAdorno.codigo} - ${deptoAdorno.nombre}`);

  // 3. Verificar que esté asociado en departamentos_lineas
  const asignacion = await prisma.departamentoLinea.findFirst({
    where: { lineaId: lineaBota.id, departamentoId: deptoAdorno.id, activo: true, eliminadoEn: null },
  });
  if (!asignacion) {
    throw new Error(`El departamento ${deptoAdorno.codigo} no está asignado a la línea ${lineaBota.codigo}.`);
  }
  console.log(`✓ Asignación Departamento-Línea confirmada: [ID ${asignacion.id}]`);

  // 4. Regla de prefijo histórico para ADORNO: 18
  const PREFIJO_ADORNO = 18;
  const CONSECUTIVO_BASE_HISTORICO = 36; // Claves históricas 1801 a 1835

  // 5. Verificar colisión de prefijo en otros grupos
  const grupoConPrefijo = await prisma.grupoCodificacionDefecto.findFirst({
    where: { prefijo: PREFIJO_ADORNO },
    include: { linea: true, departamento: true },
  });

  if (grupoConPrefijo && (grupoConPrefijo.lineaId !== lineaBota.id || grupoConPrefijo.departamentoId !== deptoAdorno.id)) {
    throw new Error(
      `El prefijo ${PREFIJO_ADORNO} ya está asignado a otro grupo: Línea ${grupoConPrefijo.linea.codigo}, Depto ${grupoConPrefijo.departamento.codigo}`
    );
  }

  // 6. Consultar máximo existente en el rango 1801–1899 para el departamento ADORNO
  const { min, max } = rangoDeGrupo(PREFIJO_ADORNO);
  const maxDefecto = await prisma.defecto.aggregate({
    _max: { clave: true },
    where: {
      departamentoId: deptoAdorno.id,
      clave: { gte: min, lte: max },
    },
  });

  const maxClave = maxDefecto._max.clave;
  const consecutivoCalculado = maxClave
    ? Math.min(maxClave - PREFIJO_ADORNO * 100 + 1, CONSECUTIVO_AGOTADO)
    : 1;

  const siguienteConsecutivoFinal = Math.max(consecutivoCalculado, CONSECUTIVO_BASE_HISTORICO);

  console.log(`\nAnálisis de claves para Prefijo ${PREFIJO_ADORNO} (${min} - ${max}):`);
  console.log(`  Clave máxima encontrada en BD: ${maxClave ?? "Ninguna"}`);
  console.log(`  Consecutivo calculado: ${consecutivoCalculado}`);
  console.log(`  Siguiente consecutivo seguro a aplicar: ${siguienteConsecutivoFinal} (próxima clave: #${claveDe(PREFIJO_ADORNO, siguienteConsecutivoFinal)})`);

  // 7. Ejecutar transacción idempotente
  await prisma.$transaction(async (tx) => {
    const existente = await tx.grupoCodificacionDefecto.findUnique({
      where: {
        unique_grupo_linea_depto: {
          lineaId: lineaBota.id,
          departamentoId: deptoAdorno.id,
        },
      },
    });

    if (existente) {
      console.log(`\nEl grupo [ID ${existente.id}] BOTA + ADORNO ya existe en la base de datos.`);
      if (existente.siguienteConsecutivo < siguienteConsecutivoFinal) {
        console.log(`-> Actualizando siguienteConsecutivo de ${existente.siguienteConsecutivo} a ${siguienteConsecutivoFinal} para proteger históricos.`);
        await tx.grupoCodificacionDefecto.update({
          where: { id: existente.id },
          data: {
            siguienteConsecutivo: siguienteConsecutivoFinal,
            activo: true,
          },
        });
      } else {
        console.log(`-> Consecutivo actual (${existente.siguienteConsecutivo}) es seguro. Se conserva sin alteraciones.`);
      }
    } else {
      console.log(`\nCreando nuevo grupo de codificación para BOTA + ADORNO...`);
      const nuevo = await tx.grupoCodificacionDefecto.create({
        data: {
          lineaId: lineaBota.id,
          departamentoId: deptoAdorno.id,
          prefijo: PREFIJO_ADORNO,
          siguienteConsecutivo: siguienteConsecutivoFinal,
          activo: true,
        },
      });
      console.log(`✓ Grupo creado exitosamente: [ID ${nuevo.id}] Línea ${lineaBota.codigo} + Depto ${deptoAdorno.codigo} | Prefijo: ${nuevo.prefijo} | Siguiente Consecutivo: ${nuevo.siguienteConsecutivo}`);
    }
  });

  console.log("\n=================================================================");
  console.log("Seed completado exitosamente.");
  console.log("=================================================================");
}

main()
  .catch((e) => {
    console.error("Error al ejecutar seed-config-defectos:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

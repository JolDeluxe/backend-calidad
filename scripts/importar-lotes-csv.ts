import { importarLotesDesdeCSV } from "../src/modules/lotes/services/lotes-import.service";
import { resolverRutaLotesCSV } from "../src/modules/lotes/services/lotes-file-resolver";
import { prisma } from "../src/config/database";

async function main() {
  console.log("==========================================================================");
  console.log("🚀 IMPORTACIÓN MANUAL SEGURA DE LOTES: Calidad Datos Base.csv");
  console.log("==========================================================================");

  // Parsear argumentos de línea de comando
  const args = process.argv.slice(2);
  let customPath: string | undefined;
  let batchSize = 150;
  let permitirInactivacion = true;

  for (const arg of args) {
    if (arg.startsWith("--archivo=")) {
      customPath = arg.split("=")[1].replace(/^["']|["']$/g, "").trim();
    } else if (arg.startsWith("--batch=")) {
      batchSize = parseInt(arg.split("=")[1], 10) || 150;
    } else if (arg === "--no-inactivar") {
      permitirInactivacion = false;
    }
  }

  try {
    // 1. Resolver ruta oficial si no se especificó un archivo personalizado
    const resolvedPath = customPath || (await resolverRutaLotesCSV({ modoEstricto: false }));
    console.log(`📁 Archivo maestro seleccionado: ${resolvedPath}`);

    const result = await importarLotesDesdeCSV({
      filePath: resolvedPath,
      batchSize,
      permitirInactivacion,
      origenDisparador: "MANUAL_CLI",
    });

    console.log("\n📊 RESULTADOS DE LA IMPORTACIÓN:");
    console.log(`- Archivo procesado:         ${result.archivoUtilizado}`);
    console.log(`- SHA-256:                   ${result.hashSha256}`);
    console.log(`- Tamaño:                    ${result.tamanoBytes} bytes`);
    console.log(`- Total de filas leídas:     ${result.totalLeidos}`);
    console.log(`- Nuevos lotes insertados:   ${result.insertados}`);
    console.log(`- Lotes actualizados:        ${result.actualizados}`);
    console.log(`- Lotes omitidos (sin mod):  ${result.omitidos}`);
    console.log(`- Lotes inactivados:         ${result.inactivados} (${result.inactivacionEjecutada ? "Ejecutada" : "Omitida"})`);
    if (!result.inactivacionEjecutada && result.inactivacionMotivoOmision) {
      console.log(`  ℹ️ Motivo inactivación:     ${result.inactivacionMotivoOmision}`);
    }
    console.log(`- Lotes rechazados/errores:  ${result.rechazados}`);
    console.log(`- Anomalías no bloqueantes:  ${result.anomalias.length}`);
    console.log(`- Duración total:            ${result.duracionMs} ms`);

    if (result.errores.length > 0) {
      console.log(`\n⚠️ DETALLE DE RECHAZOS (primeros 10 de ${result.errores.length}):`);
      result.errores.slice(0, 10).forEach((err) => {
        console.log(`  [Fila ${err.fila}] Lote: ${err.lote || "N/A"} - Motivo: ${err.motivo}`);
      });
    }

    if (result.anomalias.length > 0) {
      console.log(`\nℹ️ ANOMALÍAS REGISTRADAS (primeras 5 de ${result.anomalias.length}):`);
      result.anomalias.slice(0, 5).forEach((anom) => {
        console.log(`  [Fila ${anom.fila}] Lote: ${anom.lote} - ${anom.motivo}`);
      });
    }

    // Comprobación de integridad con un lote testigo
    const loteControl = await prisma.produccionLote.findFirst({
      where: { estado: "ACTIVO" },
      orderBy: { id: "desc" },
    });

    if (loteControl) {
      console.log("\n🔍 MUESTRA DE LOTE ACTIVO VERIFICADO EN MYSQL:");
      console.log(`  ID:          ${loteControl.id}`);
      console.log(`  Lote:        ${loteControl.lote}`);
      console.log(`  Lista:       ${loteControl.lista}`);
      console.log(`  IdProducto:  ${loteControl.idProducto}`);
      console.log(`  Modelo:      ${loteControl.modelo}`);
      console.log(`  Cantidad:    ${loteControl.cantidad.toString()}`);
      console.log(`  Cliente:     ${loteControl.cliente}`);
    }

    await prisma.$disconnect();
    console.log("\n✨ Importación finalizada exitosamente.");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Error durante la importación manual de lotes:", error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();

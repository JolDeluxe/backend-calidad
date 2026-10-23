import { importarLotesDesdeCSV } from "../src/modules/lotes/services/lotes-import.service";
import { prisma } from "../src/config/database";

async function main() {
  console.log("==========================================================================");
  console.log("🚀 INICIANDO IMPORTACIÓN OFICIAL DEL MAESTRO DE LOTES: Calidad Datos Base.csv");
  console.log("==========================================================================");

  try {
    const result = await importarLotesDesdeCSV({
      filePath: "C:/Users/MBCPROEW10028/Downloads/DtaosBse/Calidad Datos Base.csv",
      batchSize: 150,
    });

    console.log("\n📊 RESULTADOS DE LA IMPORTACIÓN:");
    console.log(`- Total de filas leídas:    ${result.totalLeidos}`);
    console.log(`- Nuevos lotes insertados:  ${result.insertados}`);
    console.log(`- Lotes actualizados:       ${result.actualizados}`);
    console.log(`- Lotes omitidos (sin cambios): ${result.omitidos}`);
    console.log(`- Lotes rechazados/errores: ${result.rechazados}`);
    console.log(`- Anomalías no bloqueantes registradas: ${result.anomalias.length}`);
    console.log(`- Duración total:           ${result.duracionMs} ms`);

    if (result.errores.length > 0) {
      console.log("\n⚠️ DETALLE DE ERRORES/RECHAZOS:");
      result.errores.forEach((err) => {
        console.log(`  [Fila ${err.fila}] Lote: ${err.lote || "N/A"} - Motivo: ${err.motivo}`);
      });
    }

    if (result.anomalias.length > 0) {
      console.log(`\nℹ️ ANOMALÍAS REGISTRADAS (Primeras 5 de ${result.anomalias.length}):`);
      result.anomalias.slice(0, 5).forEach((anom) => {
        console.log(`  [Fila ${anom.fila}] Lote: ${anom.lote} - ${anom.motivo}`);
      });
    }

    // Comprobación de lote 36296
    const loteControl = await prisma.produccionLote.findUnique({
      where: { lote: "36296" },
    });

    console.log("\n🔍 COMPROBACIÓN DE LOTE CONTROL #36296:");
    if (loteControl) {
      console.log(`  ID:          ${loteControl.id}`);
      console.log(`  Lote:        ${loteControl.lote}`);
      console.log(`  Lista:       ${loteControl.lista}`);
      console.log(`  IdProducto:  ${loteControl.idProducto}`);
      console.log(`  Modelo:      ${loteControl.modelo}`);
      console.log(`  Cantidad:    ${loteControl.cantidad.toString()}`);
      console.log(`  Cliente:     ${loteControl.cliente}`);
      console.log(`  Horma:       ${loteControl.horma}`);
    } else {
      console.error("  ❌ Lote #36296 no encontrado en MySQL!");
    }

    // Comprobación de muestras con descripción vacía
    const muestrasVacias = await prisma.produccionLote.findMany({
      where: { cliente: "MUESTRAS", descripcion: null },
    });
    console.log(`\n🔍 Muestras con descripción null/vacía preservada: ${muestrasVacias.length}`);

    await prisma.$disconnect();
    console.log("\n✨ Proceso finalizado exitosamente.");
  } catch (error) {
    console.error("\n❌ Error crítico durante la importación:", error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();

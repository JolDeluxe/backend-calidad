import { prisma } from "../src/config/database";
import fs from "fs";
import path from "path";
import crypto from "crypto";

async function applyMigration() {
  const migrationName = "20261022000000_add_produccion_lotes_inspecciones";
  const migrationPath = path.resolve(__dirname, `../prisma/migrations/${migrationName}/migration.sql`);

  console.log(`Leyendo archivo de migración: ${migrationPath}`);
  const sql = fs.readFileSync(migrationPath, "utf8");

  // Calcular checksum sha256 del sql
  const checksum = crypto.createHash("sha256").update(sql).digest("hex");

  const stmts = sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`Ejecutando ${stmts.length} sentencias DDL en MySQL...`);
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    await prisma.$executeRawUnsafe(stmt);
    console.log(`[${i + 1}/${stmts.length}] Sentencia aplicada`);
  }

  // Registrar en _prisma_migrations de forma compatible
  await prisma.$executeRawUnsafe(`
    INSERT INTO _prisma_migrations (
      id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count
    ) VALUES (
      UUID(), '${checksum}', NOW(3), '${migrationName}', NULL, NULL, NOW(3), 1
    )
  `);

  console.log("✅ Migración aplicada y registrada con éxito en _prisma_migrations.");
  await prisma.$disconnect();
}

applyMigration().catch((err) => {
  console.error("❌ Error aplicando migración:", err);
  process.exit(1);
});

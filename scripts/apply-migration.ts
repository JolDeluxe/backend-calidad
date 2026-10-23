import { prisma } from "../src/config/database";
import fs from "fs";

async function applyMigration() {
  const sql = fs.readFileSync(
    "prisma/migrations/20261021000000_add_catalogos_departamentos_defectos/migration.sql",
    "utf8"
  );
  const stmts = sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`Ejecutando ${stmts.length} sentencias DDL...`);
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    await prisma.$executeRawUnsafe(stmt);
    console.log(`[${i + 1}/${stmts.length}] Sentencia aplicada`);
  }

  // Registrar en _prisma_migrations
  await prisma.$executeRawUnsafe(`
    INSERT INTO _prisma_migrations (
      id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count
    ) VALUES (
      UUID(), 'c8d4851eb39db795e1c07f43db481eb0330043c1eeeb8e2a3be6ec93cb1a4bc5',
      NOW(3), '20261021000000_add_catalogos_departamentos_defectos', NULL, NULL, NOW(3), 1
    )
  `);

  console.log("✅ Migración aplicada y registrada con éxito.");
  await prisma.$disconnect();
}

applyMigration().catch((err) => {
  console.error("❌ Error aplicando migración:", err);
  process.exit(1);
});

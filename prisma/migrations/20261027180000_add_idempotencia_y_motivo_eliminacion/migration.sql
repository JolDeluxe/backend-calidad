-- Fase 4: idempotencia de captura (clave opcional por inspector; múltiples NULL permitidos en MySQL)
-- Fase 5: motivo del borrado lógico de defectos registrados
-- Migración aditiva: sin pérdida de datos ni cambios destructivos.

-- AlterTable
ALTER TABLE `inspecciones_cabecera` ADD COLUMN `clave_idempotencia` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `inspecciones_detalle` ADD COLUMN `eliminado_motivo` VARCHAR(255) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `unique_inspector_clave_idempotencia` ON `inspecciones_cabecera`(`inspector_id`, `clave_idempotencia`);

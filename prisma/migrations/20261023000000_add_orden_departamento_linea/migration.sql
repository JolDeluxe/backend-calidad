-- AlterTable
ALTER TABLE `departamentos_lineas` ADD COLUMN `orden` INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX `departamentos_lineas_orden_idx` ON `departamentos_lineas`(`orden`);

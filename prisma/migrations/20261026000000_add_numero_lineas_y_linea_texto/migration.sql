-- AlterTable
ALTER TABLE `departamentos` ADD COLUMN `numero_lineas` INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE `inspecciones_cabecera` ADD COLUMN `linea_texto` VARCHAR(30) NULL;

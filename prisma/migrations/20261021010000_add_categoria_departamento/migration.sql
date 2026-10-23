-- AlterTable
ALTER TABLE `departamentos` ADD COLUMN `categoria_departamento_id` INTEGER NULL;

-- CreateTable
CREATE TABLE `categorias_departamento` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `nombre` VARCHAR(100) NOT NULL,
    `descripcion` VARCHAR(255) NULL,
    `activo` BOOLEAN NOT NULL DEFAULT true,
    `creado_por` INTEGER NULL,
    `creado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizado_por` INTEGER NULL,
    `actualizado_en` DATETIME(3) NOT NULL,
    `eliminado_por` INTEGER NULL,
    `eliminado_en` DATETIME(3) NULL,

    UNIQUE INDEX `categorias_departamento_nombre_key`(`nombre`),
    INDEX `categorias_departamento_activo_idx`(`activo`),
    INDEX `categorias_departamento_eliminado_en_idx`(`eliminado_en`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `departamentos_categoria_departamento_id_idx` ON `departamentos`(`categoria_departamento_id`);

-- AddForeignKey
ALTER TABLE `departamentos` ADD CONSTRAINT `departamentos_categoria_departamento_id_fkey` FOREIGN KEY (`categoria_departamento_id`) REFERENCES `categorias_departamento`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

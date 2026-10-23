-- AlterTable
ALTER TABLE `departamentos` ADD COLUMN `actualizado_por` INTEGER NULL,
    ADD COLUMN `creado_por` INTEGER NULL,
    ADD COLUMN `eliminado_en` DATETIME(3) NULL,
    ADD COLUMN `eliminado_por` INTEGER NULL;

-- CreateTable
CREATE TABLE `tipos_operacion` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `codigo` VARCHAR(30) NOT NULL,
    `nombre` VARCHAR(100) NOT NULL,
    `descripcion` VARCHAR(255) NULL,
    `estado` ENUM('ACTIVO', 'INACTIVO') NOT NULL DEFAULT 'ACTIVO',
    `creado_por` INTEGER NULL,
    `fecha_creacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizado_por` INTEGER NULL,
    `fecha_actualizacion` DATETIME(3) NOT NULL,
    `eliminado_por` INTEGER NULL,
    `eliminado_en` DATETIME(3) NULL,

    UNIQUE INDEX `tipos_operacion_codigo_key`(`codigo`),
    INDEX `tipos_operacion_estado_idx`(`estado`),
    INDEX `tipos_operacion_eliminado_en_idx`(`eliminado_en`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lineas` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tipo_operacion_id` INTEGER NOT NULL,
    `codigo` VARCHAR(30) NOT NULL,
    `nombre` VARCHAR(100) NOT NULL,
    `descripcion` VARCHAR(255) NULL,
    `estado` ENUM('ACTIVO', 'INACTIVO') NOT NULL DEFAULT 'ACTIVO',
    `creado_por` INTEGER NULL,
    `fecha_creacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizado_por` INTEGER NULL,
    `fecha_actualizacion` DATETIME(3) NOT NULL,
    `eliminado_por` INTEGER NULL,
    `eliminado_en` DATETIME(3) NULL,

    INDEX `lineas_tipo_operacion_id_idx`(`tipo_operacion_id`),
    INDEX `lineas_estado_idx`(`estado`),
    INDEX `lineas_eliminado_en_idx`(`eliminado_en`),
    UNIQUE INDEX `lineas_tipo_operacion_id_codigo_key`(`tipo_operacion_id`, `codigo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `departamentos_lineas` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `departamento_id` INTEGER NOT NULL,
    `linea_id` INTEGER NOT NULL,
    `activo` BOOLEAN NOT NULL DEFAULT true,
    `creado_por` INTEGER NULL,
    `fecha_creacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizado_por` INTEGER NULL,
    `fecha_actualizacion` DATETIME(3) NOT NULL,
    `eliminado_por` INTEGER NULL,
    `eliminado_en` DATETIME(3) NULL,

    INDEX `departamentos_lineas_departamento_id_idx`(`departamento_id`),
    INDEX `departamentos_lineas_linea_id_idx`(`linea_id`),
    INDEX `departamentos_lineas_activo_idx`(`activo`),
    UNIQUE INDEX `departamentos_lineas_departamento_id_linea_id_key`(`departamento_id`, `linea_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `secuencias_clave_defecto` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `siguiente_clave` INTEGER NOT NULL DEFAULT 1836,
    `fecha_actualizacion` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `defectos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `clave` INTEGER NOT NULL,
    `defecto` VARCHAR(255) NOT NULL,
    `clasificacion` ENUM('CRITICO', 'MAYOR', 'MENOR') NOT NULL,
    `activo` BOOLEAN NOT NULL DEFAULT true,
    `creado_por` INTEGER NOT NULL,
    `creado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizado_por` INTEGER NULL,
    `actualizado_en` DATETIME(3) NOT NULL,
    `eliminado_por` INTEGER NULL,
    `eliminado_en` DATETIME(3) NULL,

    UNIQUE INDEX `defectos_clave_key`(`clave`),
    INDEX `defectos_clave_idx`(`clave`),
    INDEX `defectos_activo_idx`(`activo`),
    INDEX `defectos_clasificacion_idx`(`clasificacion`),
    INDEX `defectos_eliminado_en_idx`(`eliminado_en`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `defectos_departamentos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `defecto_id` INTEGER NOT NULL,
    `departamento_id` INTEGER NOT NULL,
    `activo` BOOLEAN NOT NULL DEFAULT true,
    `creado_por` INTEGER NULL,
    `creado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizado_por` INTEGER NULL,
    `actualizado_en` DATETIME(3) NOT NULL,
    `eliminado_por` INTEGER NULL,
    `eliminado_en` DATETIME(3) NULL,

    INDEX `defectos_departamentos_defecto_id_idx`(`defecto_id`),
    INDEX `defectos_departamentos_departamento_id_idx`(`departamento_id`),
    INDEX `defectos_departamentos_activo_idx`(`activo`),
    UNIQUE INDEX `defectos_departamentos_defecto_id_departamento_id_key`(`defecto_id`, `departamento_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `departamentos_eliminado_en_idx` ON `departamentos`(`eliminado_en`);

-- AddForeignKey
ALTER TABLE `lineas` ADD CONSTRAINT `lineas_tipo_operacion_id_fkey` FOREIGN KEY (`tipo_operacion_id`) REFERENCES `tipos_operacion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `departamentos_lineas` ADD CONSTRAINT `departamentos_lineas_departamento_id_fkey` FOREIGN KEY (`departamento_id`) REFERENCES `departamentos`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `departamentos_lineas` ADD CONSTRAINT `departamentos_lineas_linea_id_fkey` FOREIGN KEY (`linea_id`) REFERENCES `lineas`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `defectos` ADD CONSTRAINT `defectos_creado_por_fkey` FOREIGN KEY (`creado_por`) REFERENCES `usuarios`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `defectos` ADD CONSTRAINT `defectos_actualizado_por_fkey` FOREIGN KEY (`actualizado_por`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `defectos` ADD CONSTRAINT `defectos_eliminado_por_fkey` FOREIGN KEY (`eliminado_por`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `defectos_departamentos` ADD CONSTRAINT `defectos_departamentos_defecto_id_fkey` FOREIGN KEY (`defecto_id`) REFERENCES `defectos`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `defectos_departamentos` ADD CONSTRAINT `defectos_departamentos_departamento_id_fkey` FOREIGN KEY (`departamento_id`) REFERENCES `departamentos`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

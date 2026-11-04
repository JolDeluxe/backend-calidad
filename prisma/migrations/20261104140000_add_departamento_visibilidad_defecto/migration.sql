-- CreateTable: departamentos_visibilidad_defectos
CREATE TABLE IF NOT EXISTS `departamentos_visibilidad_defectos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `departamento_origen_id` INTEGER NOT NULL,
    `departamento_destino_id` INTEGER NOT NULL,
    `permitido` BOOLEAN NOT NULL DEFAULT true,
    `creado_por` INTEGER NULL,
    `fecha_creacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizado_por` INTEGER NULL,
    `fecha_actualizacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    INDEX `departamentos_visibilidad_defectos_departamento_origen_id_idx`(`departamento_origen_id`),
    INDEX `departamentos_visibilidad_defectos_departamento_destino_id_idx`(`departamento_destino_id`),
    INDEX `departamentos_visibilidad_defectos_permitido_idx`(`permitido`),
    UNIQUE INDEX `unique_depto_origen_destino`(`departamento_origen_id`, `departamento_destino_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `departamentos_visibilidad_defectos` ADD CONSTRAINT `departamentos_visibilidad_defectos_departamento_origen_id_fkey` FOREIGN KEY (`departamento_origen_id`) REFERENCES `departamentos`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `departamentos_visibilidad_defectos` ADD CONSTRAINT `departamentos_visibilidad_defectos_departamento_destino_id_fkey` FOREIGN KEY (`departamento_destino_id`) REFERENCES `departamentos`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

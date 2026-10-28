-- CreateTable
CREATE TABLE `terminales_recuperacion_codigos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `terminal_id` INTEGER NOT NULL,
    `codigo_hash` VARCHAR(128) NOT NULL,
    `creado_por` INTEGER NOT NULL,
    `intentos_fallidos` INTEGER NOT NULL DEFAULT 0,
    `max_intentos` INTEGER NOT NULL DEFAULT 3,
    `usado_en` DATETIME(3) NULL,
    `expira_en` DATETIME(3) NOT NULL,
    `fecha_creacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `terminales_recuperacion_codigos_terminal_id_idx`(`terminal_id`),
    INDEX `terminales_recuperacion_codigos_expira_en_idx`(`expira_en`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `terminales_recuperacion_codigos` ADD CONSTRAINT `terminales_recuperacion_codigos_terminal_id_fkey` FOREIGN KEY (`terminal_id`) REFERENCES `terminales`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `terminales_recuperacion_codigos` ADD CONSTRAINT `terminales_recuperacion_codigos_creado_por_fkey` FOREIGN KEY (`creado_por`) REFERENCES `usuarios`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

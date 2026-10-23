-- CreateTable: control_cadena_auditoria (Fila única de control y exclusión mutua para encadenamiento criptográfico)
CREATE TABLE IF NOT EXISTS `control_cadena_auditoria` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `ultimo_hash` VARCHAR(64) NOT NULL,
    `ultimo_evento_id` INTEGER NULL,
    `total_eventos` INTEGER NOT NULL DEFAULT 0,
    `fecha_actualizacion` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Inicializar la fila de control única id = 1 si no existe
INSERT INTO `control_cadena_auditoria` (`id`, `ultimo_hash`, `ultimo_evento_id`, `total_eventos`, `fecha_actualizacion`)
SELECT 1, 'GENESIS_CALIDAD_AUDIT_HASH_V1', NULL, 0, NOW(3)
WHERE NOT EXISTS (SELECT 1 FROM `control_cadena_auditoria` WHERE `id` = 1);

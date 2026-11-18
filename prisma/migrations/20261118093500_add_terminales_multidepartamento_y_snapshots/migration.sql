-- ============================================================================
-- MIGRACIÓN: TERMINALES MULTIDEPARTAMENTO, GARANTÍA DE PRINCIPAL Y SNAPSHOTS
-- ============================================================================

-- 1. Crear tabla intermedia terminales_departamentos con índice único funcional en MySQL 8.0
CREATE TABLE IF NOT EXISTS `terminales_departamentos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `terminal_id` INTEGER NOT NULL,
    `departamento_id` INTEGER NOT NULL,
    `es_principal` BOOLEAN NOT NULL DEFAULT false,
    `activo` BOOLEAN NOT NULL DEFAULT true,
    `creado_por` INTEGER NULL,
    `fecha_creacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizado_por` INTEGER NULL,
    `fecha_actualizacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    INDEX `terminales_departamentos_terminal_id_idx`(`terminal_id`),
    INDEX `terminales_departamentos_departamento_id_idx`(`departamento_id`),
    INDEX `terminales_departamentos_activo_idx`(`activo`),
    UNIQUE INDEX `unique_terminal_departamento`(`terminal_id`, `departamento_id`),
    UNIQUE INDEX `unique_un_solo_principal_activo`((CASE WHEN `es_principal` = 1 AND `activo` = 1 THEN `terminal_id` ELSE NULL END)),
    CONSTRAINT `chk_principal_debe_estar_activo` CHECK (NOT (`es_principal` = 1 AND `activo` = 0)),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 2. Claves foráneas de terminales_departamentos
ALTER TABLE `terminales_departamentos`
    ADD CONSTRAINT `terminales_departamentos_terminal_id_fkey`
    FOREIGN KEY (`terminal_id`) REFERENCES `terminales`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `terminales_departamentos`
    ADD CONSTRAINT `terminales_departamentos_departamento_id_fkey`
    FOREIGN KEY (`departamento_id`) REFERENCES `departamentos`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Agregar columnas de snapshot a inspecciones_cabecera (NULLABLE para retrocompatibilidad 100%)
ALTER TABLE `inspecciones_cabecera`
    ADD COLUMN `terminal_texto` VARCHAR(60) NULL AFTER `terminal_id`,
    ADD COLUMN `lugar_deteccion_texto` VARCHAR(100) NULL AFTER `terminal_texto`,
    ADD COLUMN `departamentos_terminal_snapshot` JSON NULL AFTER `lugar_deteccion_texto`;

-- 4. Agregar columnas de snapshot a inspecciones_detalle (NULLABLE para retrocompatibilidad 100%)
ALTER TABLE `inspecciones_detalle`
    ADD COLUMN `es_depto_externo` BOOLEAN NULL AFTER `pares_defectuosos`,
    ADD COLUMN `lugar_deteccion_texto` VARCHAR(100) NULL AFTER `es_depto_externo`,
    ADD COLUMN `nomenclatura_texto` VARCHAR(255) NULL AFTER `lugar_deteccion_texto`;

-- 5. Backfill DML idempotente con WHERE NOT EXISTS (no sobrescribe asociaciones existentes ni reactiva inactivas)
INSERT INTO `terminales_departamentos` (
    `terminal_id`,
    `departamento_id`,
    `es_principal`,
    `activo`,
    `fecha_creacion`,
    `fecha_actualizacion`
)
SELECT
    t.`id`,
    t.`departamento_id`,
    1,
    1,
    NOW(3),
    NOW(3)
FROM `terminales` t
WHERE NOT EXISTS (
    SELECT 1
    FROM `terminales_departamentos` td
    WHERE td.`terminal_id` = t.`id`
      AND td.`departamento_id` = t.`departamento_id`
);

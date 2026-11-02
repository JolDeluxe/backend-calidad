-- 1. Agregar temporalmente la columna departamento_id como NULLABLE
ALTER TABLE `defectos` ADD COLUMN `departamento_id` INTEGER NULL;

-- 2. Recuperar el departamento propietario a partir de los grupos de codificación
-- Regla de negocio MBC: cada clave de defecto se codifica como prefijo * 100 + consecutivo.
-- La tabla grupos_codificacion_defecto posee la restricción UNIQUE `unique_grupo_prefijo` (prefijo),
-- vinculando de forma unívoca cada prefijo con su departamento propietario.
UPDATE `defectos` d
JOIN `grupos_codificacion_defecto` gcd ON FLOOR(d.clave / 100) = gcd.prefijo
SET d.departamento_id = gcd.departamento_id
WHERE d.departamento_id IS NULL;

-- 3. Validación de seguridad e integridad:
-- Si existen defectos donde no se pudo determinar el departamento propietario,
-- abortar la migración inmediatamente mediante una señal SQL para prevenir asignaciones arbitrarias
-- y exigir la homologación previa de dichos registros.
SET @sin_depto = (SELECT COUNT(*) FROM `defectos` WHERE `departamento_id` IS NULL);
SET @mensaje_error = CONCAT('Error de migración: Existen ', @sin_depto, ' defectos sin departamento propietario determinable por prefijo. Se requiere homologación previa.');

-- En MySQL, si @sin_depto > 0 se dispara un error que detiene la migración
SET @sql_check = IF(@sin_depto > 0, 
    CONCAT('SIGNAL SQLSTATE \'45000\' SET MESSAGE_TEXT = \'', @mensaje_error, '\';'), 
    'SELECT 1;'
);
PREPARE stmt_check FROM @sql_check;
EXECUTE stmt_check;
DEALLOCATE PREPARE stmt_check;

-- 4. Establecer departamento_id como NOT NULL conforme a schema.prisma
ALTER TABLE `defectos` MODIFY COLUMN `departamento_id` INTEGER NOT NULL;

-- 5. Crear índice para optimizar búsquedas por departamento propietario
CREATE INDEX `defectos_departamento_id_idx` ON `defectos`(`departamento_id`);

-- 6. Agregar clave foránea de departamento propietario
ALTER TABLE `defectos` ADD CONSTRAINT `defectos_departamento_id_fkey` 
    FOREIGN KEY (`departamento_id`) REFERENCES `departamentos`(`id`) 
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. Crear la tabla defectos_etapas con la estructura exacta de model DefectoEtapa en schema.prisma
CREATE TABLE `defectos_etapas` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `defecto_id` INTEGER NOT NULL,
    `departamento_id` INTEGER NOT NULL,
    `permitido` BOOLEAN NOT NULL DEFAULT true,
    `creado_por` INTEGER NULL,
    `creado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizado_por` INTEGER NULL,
    `actualizado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `unique_defecto_etapa`(`defecto_id`, `departamento_id`),
    INDEX `defectos_etapas_defecto_id_idx`(`defecto_id`),
    INDEX `defectos_etapas_departamento_id_idx`(`departamento_id`),
    INDEX `defectos_etapas_permitido_idx`(`permitido`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 8. Claves foráneas para defectos_etapas
ALTER TABLE `defectos_etapas` ADD CONSTRAINT `defectos_etapas_defecto_id_fkey` 
    FOREIGN KEY (`defecto_id`) REFERENCES `defectos`(`id`) 
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `defectos_etapas` ADD CONSTRAINT `defectos_etapas_departamento_id_fkey` 
    FOREIGN KEY (`departamento_id`) REFERENCES `departamentos`(`id`) 
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Migración NO DESTRUCTIVA: solo crea la tabla de configuración de codificación de defectos.
-- No modifica ni elimina tablas ni datos existentes (defectos, secuencias_clave_defecto, etc.).

-- CreateTable
CREATE TABLE `grupos_codificacion_defecto` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `linea_id` INTEGER NOT NULL,
    `departamento_id` INTEGER NOT NULL,
    `prefijo` INTEGER NOT NULL,
    `siguiente_consecutivo` INTEGER NOT NULL DEFAULT 1,
    `activo` BOOLEAN NOT NULL DEFAULT true,
    `creado_por` INTEGER NULL,
    `fecha_creacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizado_por` INTEGER NULL,
    `fecha_actualizacion` DATETIME(3) NOT NULL,

    INDEX `grupos_codificacion_defecto_departamento_id_idx`(`departamento_id`),
    UNIQUE INDEX `unique_grupo_linea_depto`(`linea_id`, `departamento_id`),
    UNIQUE INDEX `unique_grupo_prefijo`(`prefijo`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_grupo_prefijo_dos_digitos` CHECK (`prefijo` BETWEEN 10 AND 99),
    CONSTRAINT `chk_grupo_consecutivo_rango` CHECK (`siguiente_consecutivo` BETWEEN 1 AND 100)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `grupos_codificacion_defecto` ADD CONSTRAINT `grupos_codificacion_defecto_linea_id_fkey` FOREIGN KEY (`linea_id`) REFERENCES `lineas`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `grupos_codificacion_defecto` ADD CONSTRAINT `grupos_codificacion_defecto_departamento_id_fkey` FOREIGN KEY (`departamento_id`) REFERENCES `departamentos`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Migración: 20261119150000_lotes_sync_and_lista_lote_unique
-- 1. Actualizar restricción de unicidad en produccion_lotes (de UNIQUE(lote) a UNIQUE(lista, lote))
-- Conserva el índice en lote para rendimiento de consultas por código de lote.

-- Comprobar si existe el índice único antiguo antes de eliminarlo
ALTER TABLE `produccion_lotes` DROP INDEX `produccion_lotes_lote_key`;

-- Crear índice único compuesto seguro sobre (lista, lote)
ALTER TABLE `produccion_lotes` ADD CONSTRAINT `produccion_lotes_lista_lote_unique` UNIQUE (`lista`, `lote`);

-- Asegurar índice de búsqueda rápida por lote
-- (Si ya existía produccion_lotes_lote_idx se conserva, de lo contrario se asegura)

-- 2. Crear tabla de auditoría y control de sincronización de maestro de lotes
CREATE TABLE IF NOT EXISTS `control_sincronizaciones_lotes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ejecucion_uuid` VARCHAR(64) NOT NULL,
    `archivo` VARCHAR(255) NOT NULL,
    `ruta_utilizada` VARCHAR(500) NOT NULL,
    `hash_sha256` VARCHAR(64) NULL,
    `tamano_bytes` BIGINT NULL,
    `fecha_modificacion_csv` DATETIME(3) NULL,
    `iniciado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finalizado_en` DATETIME(3) NULL,
    `duracion_ms` INTEGER NULL,
    `origen_disparador` VARCHAR(50) NOT NULL,
    `corte_programado_utc` DATETIME(3) NULL,
    `numero_intento` INTEGER NOT NULL DEFAULT 1,
    `proximo_reintento_utc` DATETIME(3) NULL,
    `registros_leidos` INTEGER NOT NULL DEFAULT 0,
    `registros_insertados` INTEGER NOT NULL DEFAULT 0,
    `registros_actualizados` INTEGER NOT NULL DEFAULT 0,
    `registros_omitidos` INTEGER NOT NULL DEFAULT 0,
    `registros_rechazados` INTEGER NOT NULL DEFAULT 0,
    `registros_inactivados` INTEGER NOT NULL DEFAULT 0,
    `estado` VARCHAR(30) NOT NULL,
    `mensaje_error` VARCHAR(1000) NULL,
    `detalle_tecnico` JSON NULL,
    `anomalias` JSON NULL,

    UNIQUE INDEX `control_sincronizaciones_lotes_ejecucion_uuid_key`(`ejecucion_uuid`),
    INDEX `control_sincronizaciones_lotes_iniciado_en_idx`(`iniciado_en`),
    INDEX `control_sincronizaciones_lotes_corte_programado_utc_estado_idx`(`corte_programado_utc`, `estado`),
    INDEX `control_sincronizaciones_lotes_estado_idx`(`estado`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

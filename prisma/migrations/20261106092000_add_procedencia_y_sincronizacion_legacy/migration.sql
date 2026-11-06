-- ============================================================================
-- MIGRACIÓN: PROCEDENCIA EXPLÍCITA, IDENTIDAD HISTÓRICA Y CONTROL INCREMENTAL
-- ============================================================================

-- 1. Paso 1: Crear columna procedencia inicialmente NULLABLE en inspecciones_cabecera
ALTER TABLE `inspecciones_cabecera`
  ADD COLUMN `procedencia` ENUM('WEB', 'LEGACY') NULL AFTER `estado`;

-- 2. Paso 2: Clasificación determinística y Backfill de registros existentes
-- 2.1. Registros históricos importados de TXT
UPDATE `inspecciones_cabecera`
SET `procedencia` = 'LEGACY'
WHERE `folio` LIKE 'HIST-%'
  AND `notas` LIKE '%Sesión histórica importada%'
  AND `clave_idempotencia` IS NULL
  AND `terminal_id` IS NULL;

-- 2.2. Registros operativos WEB (folios INS-*)
UPDATE `inspecciones_cabecera`
SET `procedencia` = 'WEB'
WHERE `folio` LIKE 'INS-%'
  AND (`notas` IS NULL OR `notas` NOT LIKE '%Sesión histórica importada%');

-- 2.3. Registros de prueba documentados en entorno de desarrollo (TEST-AJENA-*)
UPDATE `inspecciones_cabecera`
SET `procedencia` = 'WEB'
WHERE `id` IN (225386, 225408, 225447)
  AND `folio` LIKE 'TEST-AJENA-%';

-- 3. Paso 3: Convertir procedencia a NOT NULL con valor por defecto 'WEB' e índice
ALTER TABLE `inspecciones_cabecera`
  MODIFY COLUMN `procedencia` ENUM('WEB', 'LEGACY') NOT NULL DEFAULT 'WEB',
  ADD INDEX `inspecciones_cabecera_procedencia_idx` (`procedencia`);

-- 4. Evolución de inspecciones_historicas_origen (Maestro de Procedencia)
ALTER TABLE `inspecciones_historicas_origen`
  ADD COLUMN `anio_origen` INT NULL AFTER `archivo_origen`,
  ADD COLUMN `hash_fila` VARCHAR(64) NULL AFTER `no_original`,
  ADD COLUMN `fecha_actualizacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) AFTER `fecha_carga`;

-- Backfill inicial de anio_origen a partir de fecha_parseada
UPDATE `inspecciones_historicas_origen`
SET `anio_origen` = COALESCE(YEAR(`fecha_parseada`), 2024)
WHERE `anio_origen` IS NULL;

-- Backfill inicial de hash_fila
UPDATE `inspecciones_historicas_origen`
SET `hash_fila` = SHA2(
  CONCAT_WS(
    '|',
    COALESCE(`archivo_origen`, ''),
    CAST(`anio_origen` AS CHAR),
    COALESCE(`no_original`, ''),
    COALESCE(DATE_FORMAT(`fecha_parseada`, '%Y-%m-%d'), ''),
    UPPER(TRIM(COALESCE(`lista`, ''))),
    UPPER(TRIM(COALESCE(`lote`, ''))),
    UPPER(TRIM(COALESCE(`linea`, ''))),
    UPPER(TRIM(COALESCE(`modelo`, ''))),
    UPPER(TRIM(COALESCE(`def_depto`, ''))),
    CAST(COALESCE(`defecto_clave`, 0) AS CHAR),
    CAST(COALESCE(`pares`, 1) AS CHAR),
    UPPER(TRIM(COALESCE(`horma`, '')))
  ),
  256
)
WHERE `hash_fila` IS NULL;

ALTER TABLE `inspecciones_historicas_origen`
  MODIFY COLUMN `anio_origen` INT NOT NULL DEFAULT 2024,
  MODIFY COLUMN `hash_fila` VARCHAR(64) NOT NULL DEFAULT '',
  ADD UNIQUE INDEX `unique_archivo_anio_no_original` (`archivo_origen`, `anio_origen`, `no_original`),
  ADD INDEX `inspecciones_historicas_origen_hash_fila_idx` (`hash_fila`);

-- 5. Relación 1:1 opcional en inspecciones_detalle hacia inspecciones_historicas_origen (con ON DELETE RESTRICT)
ALTER TABLE `inspecciones_detalle`
  ADD COLUMN `historico_origen_id` INT NULL AFTER `notas`,
  ADD UNIQUE INDEX `inspecciones_detalle_historico_origen_id_key` (`historico_origen_id`),
  ADD CONSTRAINT `inspecciones_detalle_historico_origen_id_fkey`
    FOREIGN KEY (`historico_origen_id`)
    REFERENCES `inspecciones_historicas_origen`(`id`)
    ON DELETE RESTRICT
    ON UPDATE CASCADE;

-- 6. Tabla física separada de bloqueos por archivo
CREATE TABLE `bloqueos_sincronizacion_legacy` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `archivo` VARCHAR(100) NOT NULL,
  `propietario_uuid` VARCHAR(64) NULL,
  `adquirido_en` DATETIME(3) NULL,
  `expira_en` DATETIME(3) NULL,
  `renovado_en` DATETIME(3) NULL,
  `fecha_actualizacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `bloqueos_sincronizacion_legacy_archivo_key` (`archivo`),
  INDEX `bloqueos_sincronizacion_legacy_expira_en_idx` (`expira_en`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 7. Tabla de historial de ejecuciones de sincronización
CREATE TABLE `control_sincronizaciones_legacy` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `ejecucion_uuid` VARCHAR(64) NOT NULL,
  `archivo` VARCHAR(100) NOT NULL,
  `departamento` VARCHAR(60) NOT NULL,
  `hash_sha256_archivo` VARCHAR(64) NOT NULL,
  `tamano_bytes` BIGINT NOT NULL,
  `fecha_modificacion_txt` DATETIME(3) NOT NULL,
  `iniciado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finalizado_en` DATETIME(3) NULL,
  `registros_detectados` INT NOT NULL DEFAULT 0,
  `registros_insertados` INT NOT NULL DEFAULT 0,
  `registros_actualizados` INT NOT NULL DEFAULT 0,
  `registros_omitidos` INT NOT NULL DEFAULT 0,
  `registros_rechazados` INT NOT NULL DEFAULT 0,
  `errores_count` INT NOT NULL DEFAULT 0,
  `detalle_errores` JSON NULL,
  `estado` VARCHAR(30) NOT NULL,

  UNIQUE INDEX `control_sincronizaciones_legacy_ejecucion_uuid_key` (`ejecucion_uuid`),
  INDEX `control_sincronizaciones_legacy_archivo_estado_idx` (`archivo`, `estado`),
  INDEX `control_sincronizaciones_legacy_departamento_idx` (`departamento`),
  INDEX `control_sincronizaciones_legacy_iniciado_en_idx` (`iniciado_en`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 8. Tabla de auditoría de modificaciones legacy (con ON DELETE RESTRICT)
CREATE TABLE `historico_modificaciones_legacy` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `historico_origen_id` INT NOT NULL,
  `sincronizacion_id` INT NOT NULL,
  `hash_anterior` VARCHAR(64) NOT NULL,
  `hash_nuevo` VARCHAR(64) NOT NULL,
  `valores_anteriores` JSON NOT NULL,
  `valores_nuevos` JSON NOT NULL,
  `fecha_utc` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `historico_modificaciones_legacy_historico_origen_id_idx` (`historico_origen_id`),
  INDEX `historico_modificaciones_legacy_sincronizacion_id_idx` (`sincronizacion_id`),
  INDEX `historico_modificaciones_legacy_fecha_utc_idx` (`fecha_utc`),
  PRIMARY KEY (`id`),
  CONSTRAINT `historico_modificaciones_legacy_historico_origen_id_fkey`
    FOREIGN KEY (`historico_origen_id`)
    REFERENCES `inspecciones_historicas_origen`(`id`)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  CONSTRAINT `historico_modificaciones_legacy_sincronizacion_id_fkey`
    FOREIGN KEY (`sincronizacion_id`)
    REFERENCES `control_sincronizaciones_legacy`(`id`)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

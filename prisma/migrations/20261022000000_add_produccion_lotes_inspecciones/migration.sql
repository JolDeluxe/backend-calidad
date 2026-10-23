-- CreateTable: produccion_lotes
CREATE TABLE `produccion_lotes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `lista_lote` VARCHAR(60) NOT NULL,
    `lista` VARCHAR(30) NOT NULL,
    `lote` VARCHAR(30) NOT NULL,
    `id_producto` VARCHAR(60) NOT NULL,
    `modelo` VARCHAR(30) NOT NULL,
    `cantidad` DECIMAL(12, 4) NOT NULL,
    `descripcion` VARCHAR(255) NULL,
    `cliente` VARCHAR(150) NOT NULL,
    `horma` VARCHAR(60) NULL,
    `estado` ENUM('ACTIVO', 'INACTIVO') NOT NULL DEFAULT 'ACTIVO',
    `creado_por` INTEGER NULL,
    `fecha_creacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizado_por` INTEGER NULL,
    `fecha_actualizacion` DATETIME(3) NOT NULL,
    `eliminado_por` INTEGER NULL,
    `eliminado_en` DATETIME(3) NULL,

    UNIQUE INDEX `produccion_lotes_lote_key`(`lote`),
    INDEX `produccion_lotes_lote_idx`(`lote`),
    INDEX `produccion_lotes_lista_lote_idx`(`lista_lote`),
    INDEX `produccion_lotes_lista_idx`(`lista`),
    INDEX `produccion_lotes_id_producto_idx`(`id_producto`),
    INDEX `produccion_lotes_modelo_idx`(`modelo`),
    INDEX `produccion_lotes_cliente_idx`(`cliente`),
    INDEX `produccion_lotes_estado_idx`(`estado`),
    INDEX `produccion_lotes_eliminado_en_idx`(`eliminado_en`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: inspecciones_cabecera
CREATE TABLE `inspecciones_cabecera` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `folio` VARCHAR(30) NOT NULL,
    `lote_id` INTEGER NOT NULL,
    `inspector_id` INTEGER NOT NULL,
    `departamento_auditoria_id` INTEGER NOT NULL,
    `terminal_id` INTEGER NULL,
    `linea_id` INTEGER NULL,
    `horma` VARCHAR(60) NULL,
    `fecha_inspeccion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `estado` ENUM('APROBADO', 'RECHAZADO', 'CORREGIDO', 'PENDIENTE') NOT NULL DEFAULT 'PENDIENTE',
    `notas` VARCHAR(500) NULL,
    `creado_por` INTEGER NULL,
    `fecha_creacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizado_por` INTEGER NULL,
    `fecha_actualizacion` DATETIME(3) NOT NULL,
    `eliminado_por` INTEGER NULL,
    `eliminado_en` DATETIME(3) NULL,

    UNIQUE INDEX `inspecciones_cabecera_folio_key`(`folio`),
    INDEX `inspecciones_cabecera_folio_idx`(`folio`),
    INDEX `inspecciones_cabecera_lote_id_idx`(`lote_id`),
    INDEX `inspecciones_cabecera_inspector_id_idx`(`inspector_id`),
    INDEX `inspecciones_cabecera_departamento_auditoria_id_idx`(`departamento_auditoria_id`),
    INDEX `inspecciones_cabecera_terminal_id_idx`(`terminal_id`),
    INDEX `inspecciones_cabecera_linea_id_idx`(`linea_id`),
    INDEX `inspecciones_cabecera_fecha_inspeccion_idx`(`fecha_inspeccion`),
    INDEX `inspecciones_cabecera_estado_idx`(`estado`),
    INDEX `inspecciones_cabecera_eliminado_en_idx`(`eliminado_en`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: inspecciones_detalle
CREATE TABLE `inspecciones_detalle` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `inspeccion_id` INTEGER NOT NULL,
    `defecto_id` INTEGER NOT NULL,
    `def_depto_id` INTEGER NOT NULL,
    `pares_defectuosos` INTEGER NOT NULL DEFAULT 1,
    `notas` VARCHAR(255) NULL,
    `creado_por` INTEGER NULL,
    `fecha_creacion` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizado_por` INTEGER NULL,
    `fecha_actualizacion` DATETIME(3) NOT NULL,
    `eliminado_por` INTEGER NULL,
    `eliminado_en` DATETIME(3) NULL,

    INDEX `inspecciones_detalle_inspeccion_id_idx`(`inspeccion_id`),
    INDEX `inspecciones_detalle_defecto_id_idx`(`defecto_id`),
    INDEX `inspecciones_detalle_def_depto_id_idx`(`def_depto_id`),
    INDEX `inspecciones_detalle_eliminado_en_idx`(`eliminado_en`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: inspecciones_historicas_origen
CREATE TABLE `inspecciones_historicas_origen` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `no_original` VARCHAR(30) NULL,
    `departamento` VARCHAR(60) NULL,
    `fecha_texto` VARCHAR(60) NULL,
    `fecha_parseada` DATETIME(3) NULL,
    `lista` VARCHAR(30) NULL,
    `lote` VARCHAR(30) NULL,
    `linea` VARCHAR(60) NULL,
    `modelo` VARCHAR(30) NULL,
    `descripcion` VARCHAR(255) NULL,
    `def_depto` VARCHAR(60) NULL,
    `defecto_clave` INTEGER NULL,
    `defecto_nombre` VARCHAR(255) NULL,
    `pares` INTEGER NULL DEFAULT 0,
    `horma` VARCHAR(60) NULL,
    `usuario_texto` VARCHAR(150) NULL,
    `archivo_origen` VARCHAR(100) NULL,
    `fecha_carga` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `inspecciones_historicas_origen_lote_idx`(`lote`),
    INDEX `inspecciones_historicas_origen_lista_idx`(`lista`),
    INDEX `inspecciones_historicas_origen_modelo_idx`(`modelo`),
    INDEX `inspecciones_historicas_origen_no_original_idx`(`no_original`),
    INDEX `inspecciones_historicas_origen_def_depto_idx`(`def_depto`),
    INDEX `inspecciones_historicas_origen_defecto_clave_idx`(`defecto_clave`),
    INDEX `inspecciones_historicas_origen_archivo_origen_idx`(`archivo_origen`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKeys: produccion_lotes
ALTER TABLE `produccion_lotes` ADD CONSTRAINT `produccion_lotes_creado_por_fkey` FOREIGN KEY (`creado_por`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `produccion_lotes` ADD CONSTRAINT `produccion_lotes_actualizado_por_fkey` FOREIGN KEY (`actualizado_por`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `produccion_lotes` ADD CONSTRAINT `produccion_lotes_eliminado_por_fkey` FOREIGN KEY (`eliminado_por`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKeys: inspecciones_cabecera
ALTER TABLE `inspecciones_cabecera` ADD CONSTRAINT `inspecciones_cabecera_lote_id_fkey` FOREIGN KEY (`lote_id`) REFERENCES `produccion_lotes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `inspecciones_cabecera` ADD CONSTRAINT `inspecciones_cabecera_inspector_id_fkey` FOREIGN KEY (`inspector_id`) REFERENCES `usuarios`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `inspecciones_cabecera` ADD CONSTRAINT `inspecciones_cabecera_departamento_auditoria_id_fkey` FOREIGN KEY (`departamento_auditoria_id`) REFERENCES `departamentos`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `inspecciones_cabecera` ADD CONSTRAINT `inspecciones_cabecera_terminal_id_fkey` FOREIGN KEY (`terminal_id`) REFERENCES `terminales`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `inspecciones_cabecera` ADD CONSTRAINT `inspecciones_cabecera_linea_id_fkey` FOREIGN KEY (`linea_id`) REFERENCES `lineas`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `inspecciones_cabecera` ADD CONSTRAINT `inspecciones_cabecera_creado_por_fkey` FOREIGN KEY (`creado_por`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `inspecciones_cabecera` ADD CONSTRAINT `inspecciones_cabecera_actualizado_por_fkey` FOREIGN KEY (`actualizado_por`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `inspecciones_cabecera` ADD CONSTRAINT `inspecciones_cabecera_eliminado_por_fkey` FOREIGN KEY (`eliminado_por`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKeys: inspecciones_detalle
ALTER TABLE `inspecciones_detalle` ADD CONSTRAINT `inspecciones_detalle_inspeccion_id_fkey` FOREIGN KEY (`inspeccion_id`) REFERENCES `inspecciones_cabecera`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `inspecciones_detalle` ADD CONSTRAINT `inspecciones_detalle_defecto_id_fkey` FOREIGN KEY (`defecto_id`) REFERENCES `defectos`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `inspecciones_detalle` ADD CONSTRAINT `inspecciones_detalle_def_depto_id_fkey` FOREIGN KEY (`def_depto_id`) REFERENCES `departamentos`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

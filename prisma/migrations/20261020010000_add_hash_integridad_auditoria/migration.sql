-- AlterTable
ALTER TABLE `registros_auditoria` ADD COLUMN `hash_integridad` VARCHAR(64) NULL AFTER `agente_usuario`;

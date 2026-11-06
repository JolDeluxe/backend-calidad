import crypto from 'crypto';
import { prisma } from '../../../config/database';

export interface SyncExecutionInit {
  ejecucionUuid?: string;
  archivo: string;
  departamento: string;
  hashSha256Archivo: string;
  tamanoBytes: bigint | number;
  fechaModificacionTxt: Date;
}

export interface SyncExecutionMetrics {
  registrosDetectados: number;
  registrosInsertados: number;
  registrosActualizados: number;
  registrosOmitidos: number;
  registrosRechazados: number;
  erroresCount: number;
  detalleErrores?: unknown;
}

/**
 * Servicio de Control de Sincronización y Bloqueos Atómicos por Archivo (FASE 3.3).
 *
 * Responsabilidades:
 * 1. Separa físicamente el bloqueo por archivo (`bloqueos_sincronizacion_legacy`)
 *    del historial de ejecuciones (`control_sincronizaciones_legacy`).
 * 2. Garantiza adquisición atómica en MySQL mediante clave única por `archivo`.
 * 3. Permite renovación de vigencia exclusivamente por el propietario (`propietarioUuid`).
 * 4. Garantiza liberación segura únicamente por el propietario legítimo.
 * 5. Registra la auditoría de ejecución fuera de la transacción de importación para
 *    que los fallos y rollbacks queden siempre documentados como `FALLIDO`.
 */
export class LegacySyncLockService {
  private readonly defaultTtlMs = 120_000; // 2 minutos por defecto

  generateOwnerUuid(): string {
    return crypto.randomUUID();
  }

  /**
   * Adquiere atómicamente el bloqueo exclusivo para un archivo TXT específico.
   * Si otro proceso mantiene un bloqueo vigente (no expirado), devuelve `false`.
   */
  async acquireLock(
    archivo: string,
    propietarioUuid: string,
    ttlMs: number = this.defaultTtlMs
  ): Promise<boolean> {
    const cleanArchivo = archivo.trim();
    const now = new Date();
    const expiraEn = new Date(now.getTime() + ttlMs);

    // Garantizar que exista el registro base del archivo sin sobrescribir un propietario activo
    try {
      await prisma.bloqueoSincronizacionLegacy.create({
        data: {
          archivo: cleanArchivo,
          propietarioUuid: null,
          adquiridoEn: null,
          expiraEn: null,
          renovadoEn: null,
        },
      });
    } catch {
      // Ignorar colisión unique si la fila ya fue inicializada previamente
    }

    // Adquisición condicional atómica a nivel de fila en MySQL
    const updated = await prisma.bloqueoSincronizacionLegacy.updateMany({
      where: {
        archivo: cleanArchivo,
        OR: [
          { propietarioUuid: null },
          { expiraEn: null },
          { expiraEn: { lt: now } },
          { propietarioUuid },
        ],
      },
      data: {
        propietarioUuid,
        adquiridoEn: now,
        expiraEn,
        renovadoEn: now,
      },
    });

    return updated.count === 1;
  }

  /**
   * Renueva el tiempo de expiración del bloqueo únicamente si pertenece a `propietarioUuid`.
   */
  async renewLock(
    archivo: string,
    propietarioUuid: string,
    ttlMs: number = this.defaultTtlMs
  ): Promise<boolean> {
    const cleanArchivo = archivo.trim();
    const now = new Date();
    const expiraEn = new Date(now.getTime() + ttlMs);

    const updated = await prisma.bloqueoSincronizacionLegacy.updateMany({
      where: {
        archivo: cleanArchivo,
        propietarioUuid,
      },
      data: {
        expiraEn,
        renovadoEn: now,
      },
    });

    return updated.count === 1;
  }

  /**
   * Libera de forma segura el bloqueo únicamente si pertenece a `propietarioUuid`.
   */
  async releaseLock(archivo: string, propietarioUuid: string): Promise<boolean> {
    const cleanArchivo = archivo.trim();
    const updated = await prisma.bloqueoSincronizacionLegacy.updateMany({
      where: {
        archivo: cleanArchivo,
        propietarioUuid,
      },
      data: {
        propietarioUuid: null,
        expiraEn: null,
      },
    });

    return updated.count === 1;
  }

  /**
   * Obtiene el estado actual del bloqueo para un archivo.
   */
  async getLockState(archivo: string) {
    return prisma.bloqueoSincronizacionLegacy.findUnique({
      where: { archivo: archivo.trim() },
    });
  }

  /**
   * Crea el registro de auditoría en estado `EN_PROCESO` FUERA de la transacción de importación.
   */
  async startExecution(init: SyncExecutionInit) {
    const ejecucionUuid = init.ejecucionUuid || crypto.randomUUID();
    return prisma.controlSincronizacionLegacy.create({
      data: {
        ejecucionUuid,
        archivo: init.archivo.trim(),
        departamento: init.departamento.trim().toUpperCase(),
        hashSha256Archivo: init.hashSha256Archivo,
        tamanoBytes: BigInt(init.tamanoBytes),
        fechaModificacionTxt: init.fechaModificacionTxt,
        iniciadoEn: new Date(),
        estado: 'EN_PROCESO',
      },
    });
  }

  /**
   * Marca la ejecución como `EXITOSO` tras el commit de la transacción.
   */
  async completeExecution(id: number, metrics: SyncExecutionMetrics) {
    return prisma.controlSincronizacionLegacy.update({
      where: { id },
      data: {
        finalizadoEn: new Date(),
        registrosDetectados: metrics.registrosDetectados,
        registrosInsertados: metrics.registrosInsertados,
        registrosActualizados: metrics.registrosActualizados,
        registrosOmitidos: metrics.registrosOmitidos,
        registrosRechazados: metrics.registrosRechazados,
        erroresCount: metrics.erroresCount,
        detalleErrores: metrics.detalleErrores ? (metrics.detalleErrores as any) : undefined,
        estado: 'EXITOSO',
      },
    });
  }

  /**
   * Marca la ejecución como `FALLIDO` tras un rollback o error de validación/lectura.
   */
  async failExecution(id: number, errorDetails: unknown, partialMetrics?: Partial<SyncExecutionMetrics>) {
    return prisma.controlSincronizacionLegacy.update({
      where: { id },
      data: {
        finalizadoEn: new Date(),
        registrosDetectados: partialMetrics?.registrosDetectados ?? 0,
        registrosInsertados: partialMetrics?.registrosInsertados ?? 0,
        registrosActualizados: partialMetrics?.registrosActualizados ?? 0,
        registrosOmitidos: partialMetrics?.registrosOmitidos ?? 0,
        registrosRechazados: partialMetrics?.registrosRechazados ?? 0,
        erroresCount: Math.max(1, partialMetrics?.erroresCount ?? 1),
        detalleErrores: errorDetails as any,
        estado: 'FALLIDO',
      },
    });
  }
}

export const legacySyncLockService = new LegacySyncLockService();

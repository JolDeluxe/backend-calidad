import crypto from 'crypto';
import cron, { type ScheduledTask } from 'node-cron';
import path from 'path';
import { prisma } from '../../../config/database';
import { logger } from '../../../utils/logger';
import { syncLogger } from '../../../utils/sync-logger';
import { legacySyncLockService } from '../../inspecciones/services/legacy-sync-lock.service';
import {
  importarLotesDesdeCSV,
  type ImportLotesOptions,
  type ImportLotesResult,
} from './lotes-import.service';
import { resolverRutaLotesCSV } from './lotes-file-resolver';

export const DEFAULT_LOTES_CRON_EXPRESSION = '0 6 * * *';
export const DEFAULT_LOTES_CRON_TIMEZONE = 'America/Mexico_City';
export const GLOBAL_LOTES_LOCK_KEY = '__WORKER_LOTES_SYNC__';

export type LotesSyncTriggerSource =
  | 'CRON_SCHEDULED'
  | 'RECOVERY_MISSED_RUN'
  | 'RETRY_AUTOMATICO_30_MIN'
  | 'MANUAL_CLI'
  | 'MANUAL_API';

export interface LotesSyncCycleOutcome {
  cycleId: string;
  trigger: LotesSyncTriggerSource;
  ownerUuid?: string;
  skipped: boolean;
  skipReason?: 'ALREADY_RUNNING_IN_MEMORY' | 'GLOBAL_LOCK_HELD' | 'SHUTTING_DOWN';
  startedAt: Date;
  finishedAt: Date;
  result?: ImportLotesResult;
  error?: string;
}

export interface LotesRecoveryOutcome {
  cutoffUtc: Date;
  recoveryTriggered: boolean;
  cycleOutcome?: LotesSyncCycleOutcome;
}

export interface AsyncLotesManualRunTicket {
  accepted: boolean;
  cycleId: string;
  ownerUuid?: string;
  trigger: LotesSyncTriggerSource;
  startedAt: Date;
  skipReason?: 'ALREADY_RUNNING_IN_MEMORY' | 'GLOBAL_LOCK_HELD' | 'SHUTTING_DOWN';
  completionPromise?: Promise<LotesSyncCycleOutcome>;
}

/**
 * Servicio Integrado de Planificación, Coordinación y Recuperación Automática de Lotes.
 *
 * Responsabilidades:
 * 1. Planifica la actualización automática diaria a las 06:00 AM (America/Mexico_City).
 * 2. Bloqueo distribuido atómico en MySQL (`__WORKER_LOTES_SYNC__`) para evitar carreras y concurrencia.
 * 3. Reintento automático cada 30 minutos ante cualquier fallo hasta lograr éxito.
 * 4. Recuperación tras reinicio de PM2/servidor si el corte de las 06:00 AM no fue ejecutado con éxito hoy.
 * 5. Registro estructurado y rotativo en disco (`lotes-sync.log`) y auditoría en BD (`control_sincronizaciones_lotes`).
 * 6. Apagado ordenado ante SIGINT/SIGTERM.
 */
export class LotesSyncSchedulerService {
  private task: ScheduledTask | null = null;
  private isInitialized = false;
  private isShuttingDown = false;
  private isRunningInMemory = false;
  private currentCycleId: string | null = null;
  private currentTrigger: LotesSyncTriggerSource | null = null;
  private currentOwnerUuid: string | null = null;
  private currentStartedAt: Date | null = null;
  private currentAbortReason: string | null = null;
  private activeCyclePromise: Promise<LotesSyncCycleOutcome> | null = null;
  private lastCycleOutcome: LotesSyncCycleOutcome | null = null;

  private retryTimer: NodeJS.Timeout | null = null;
  private nextRetryAtUtc: Date | null = null;
  private retryAttemptCount = 0;

  private cronExpression: string =
    process.env.LOTES_SYNC_CRON || DEFAULT_LOTES_CRON_EXPRESSION;
  private timeZone: string = process.env.LOTES_SYNC_TZ || DEFAULT_LOTES_CRON_TIMEZONE;

  validateExpression(expr: string = this.cronExpression): boolean {
    return cron.validate(expr);
  }

  getLocalTimeParts(
    referenceUtc: Date = new Date(),
    timeZone: string = this.timeZone
  ): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  } {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });

    const parts = formatter.formatToParts(referenceUtc);
    const map: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== 'literal') {
        map[p.type] = parseInt(p.value, 10);
      }
    }

    return {
      year: map.year,
      month: map.month,
      day: map.day,
      hour: map.hour === 24 ? 0 : map.hour,
      minute: map.minute,
      second: map.second,
    };
  }

  localPartsToUtcDate(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    timeZone: string = this.timeZone
  ): Date {
    const approxUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
    const approxDate = new Date(approxUtcMs);
    const observed = this.getLocalTimeParts(approxDate, timeZone);
    const observedAsUtcMs = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
      0
    );
    const offsetMs = observedAsUtcMs - approxUtcMs;
    return new Date(approxUtcMs - offsetMs);
  }

  /**
   * Calcula el instante UTC exacto del último corte diario programado de las 06:00 AM (America/Mexico_City).
   */
  getLastScheduledCutoffUtc(
    referenceUtc: Date = new Date(),
    targetHour = 6,
    targetMinute = 0,
    timeZone: string = this.timeZone
  ): Date {
    const local = this.getLocalTimeParts(referenceUtc, timeZone);
    const todayCutoffUtc = this.localPartsToUtcDate(
      local.year,
      local.month,
      local.day,
      targetHour,
      targetMinute,
      0,
      timeZone
    );

    if (referenceUtc.getTime() >= todayCutoffUtc.getTime()) {
      return todayCutoffUtc;
    }

    const yesterdayRef = new Date(todayCutoffUtc.getTime() - 12 * 3600 * 1000);
    const yLocal = this.getLocalTimeParts(yesterdayRef, timeZone);
    return this.localPartsToUtcDate(
      yLocal.year,
      yLocal.month,
      yLocal.day,
      targetHour,
      targetMinute,
      0,
      timeZone
    );
  }

  /**
   * Programa un reintento automático en `delayMs` (30 min) si ocurrió un error en la sincronización de lotes.
   */
  scheduleRetry(delayMs = 30 * 60 * 1000, options: ImportLotesOptions = {}): void {
    if (this.isShuttingDown) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.retryAttemptCount++;
    this.nextRetryAtUtc = new Date(Date.now() + delayMs);

    logger.warn(
      {
        intento: this.retryAttemptCount,
        proximoReintentoUtc: this.nextRetryAtUtc.toISOString(),
        delayMinutos: Math.round(delayMs / 60000),
      },
      'Sincronización de Lotes: programando reintento automático en 30 minutos por fallos detectados.'
    );

    syncLogger.log({
      proceso: 'LOTES_SYNC',
      nivel: 'WARN',
      timestamp: new Date().toISOString(),
      mensaje: `Reintento automático #${this.retryAttemptCount} programado para dentro de ${Math.round(delayMs / 60000)} minutos debido a error previo.`,
      intento: this.retryAttemptCount,
      proximoReintentoUtc: this.nextRetryAtUtc.toISOString(),
      estado: 'EN_PROCESO',
    });

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAtUtc = null;
      if (this.isShuttingDown || this.isRunningInMemory) {
        if (!this.isShuttingDown) {
          this.scheduleRetry(5 * 60 * 1000, options);
        }
        return;
      }
      this.checkAndRecoverMissedRun({
        ...options,
        trigger: 'RETRY_AUTOMATICO_30_MIN',
      }).catch(err => {
        logger.error({ err }, 'Error al ejecutar reintento automático de 30 min en LotesSyncScheduler');
      });
    }, delayMs);
  }

  cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.nextRetryAtUtc = null;
    this.retryAttemptCount = 0;
  }

  private async verifyGlobalLockOwnership(ownerUuid: string): Promise<string | null> {
    if (this.currentAbortReason) return this.currentAbortReason;
    const lockState = await legacySyncLockService.getLockState(GLOBAL_LOTES_LOCK_KEY);
    const now = new Date();
    if (
      !lockState ||
      lockState.propietarioUuid !== ownerUuid ||
      !lockState.expiraEn ||
      lockState.expiraEn.getTime() <= now.getTime()
    ) {
      const reason =
        'BLOQUEO_PERDIDO_O_EXPIRADO: El proceso perdió la propiedad o vigencia del bloqueo de lotes en MySQL.';
      this.currentAbortReason = reason;
      return reason;
    }
    return null;
  }

  private async executeLockedCycle(
    cycleId: string,
    trigger: LotesSyncTriggerSource,
    ownerUuid: string,
    startedAt: Date,
    options: ImportLotesOptions
  ): Promise<LotesSyncCycleOutcome> {
    const lockTtlMs = 180_000; // 3 minutos para lotes
    this.isRunningInMemory = true;
    this.currentCycleId = cycleId;
    this.currentTrigger = trigger;
    this.currentOwnerUuid = ownerUuid;
    this.currentStartedAt = startedAt;
    this.currentAbortReason = null;

    const heartbeatMs = 45_000;
    const heartbeatTimer = setInterval(() => {
      legacySyncLockService
        .renewLock(GLOBAL_LOTES_LOCK_KEY, ownerUuid, lockTtlMs)
        .then(renewed => {
          if (!renewed && !this.currentAbortReason) {
            this.currentAbortReason =
              'BLOQUEO_PERDIDO_O_EXPIRADO: Falló la renovación del heartbeat del bloqueo de lotes.';
            logger.error({ cycleId, trigger, ownerUuid }, 'Se perdió el heartbeat del bloqueo de lotes.');
          }
        })
        .catch(err => {
          logger.warn({ err, cycleId }, 'Error transitorio al renovar heartbeat de lotes');
        });
    }, heartbeatMs);

    // Registro inicial en BD de control (si la tabla existe)
    let controlRecordId: number | null = null;
    const cutoffUtc = this.getLastScheduledCutoffUtc(startedAt, 6, 0, this.timeZone);

    try {
      if ((prisma as any).controlSincronizacionLotes) {
        const rec = await (prisma as any).controlSincronizacionLotes.create({
          data: {
            ejecucionUuid: cycleId,
            archivo: 'Calidad Datos Base.csv',
            rutaUtilizada: options.filePath || 'Pendiente de resolución',
            iniciadoEn: startedAt,
            origenDisparador: trigger,
            corteProgramadoUtc: cutoffUtc,
            numeroIntento: this.retryAttemptCount + 1,
            proximoReintentoUtc: this.nextRetryAtUtc,
            estado: 'EN_PROCESO',
          },
        });
        controlRecordId = rec.id;
      }
    } catch (dbErr) {
      logger.warn({ dbErr }, 'No se pudo crear registro previo en control_sincronizaciones_lotes (posible tabla pendiente de migración)');
    }

    try {
      logger.info({ cycleId, trigger, ownerUuid }, 'Iniciando importación automática de lotes desde CSV...');

      const result = await importarLotesDesdeCSV({
        ...options,
        ejecucionUuid: cycleId,
        origenDisparador: trigger,
      });

      const finishedAt = new Date();
      const duracionMs = finishedAt.getTime() - startedAt.getTime();
      const outcome: LotesSyncCycleOutcome = {
        cycleId,
        trigger,
        ownerUuid,
        skipped: false,
        startedAt,
        finishedAt,
        result,
      };
      this.lastCycleOutcome = outcome;

      // Actualizar registro en BD de control
      if (controlRecordId && (prisma as any).controlSincronizacionLotes) {
        try {
          await (prisma as any).controlSincronizacionLotes.update({
            where: { id: controlRecordId },
            data: {
              rutaUtilizada: result.archivoUtilizado,
              hashSha256: result.hashSha256,
              tamanoBytes: result.tamanoBytes ? BigInt(result.tamanoBytes) : null,
              fechaModificacionCsv: result.fechaModificacionArchivo,
              finalizadoEn: finishedAt,
              duracionMs,
              registrosLeidos: result.totalLeidos,
              registrosInsertados: result.insertados,
              registrosActualizados: result.actualizados,
              registrosReactivados: result.reactivados,
              registrosOmitidos: result.omitidos,
              registrosRechazados: result.rechazados,
              registrosInactivados: result.inactivados,
              estado: result.dryRun ? 'PREVISUALIZACION' : 'EXITOSO',
              detalleTecnico: {
                inactivacionEjecutada: result.inactivacionEjecutada,
                inactivacionMotivoOmision: result.inactivacionMotivoOmision,
                dryRun: result.dryRun,
              },
              anomalias: result.anomalias,
            },
          });
        } catch (updateErr) {
          logger.warn({ updateErr }, 'No se pudo actualizar registro de éxito en control_sincronizaciones_lotes');
        }
      }

      this.cancelRetry();
      logger.info(
        {
          cycleId,
          trigger,
          duracionMs,
          insertados: result.insertados,
          actualizados: result.actualizados,
          omitidos: result.omitidos,
          inactivados: result.inactivados,
          rechazados: result.rechazados,
        },
        'Importación automática de lotes finalizada con ÉXITO.'
      );

      return outcome;
    } catch (err: any) {
      const finishedAt = new Date();
      const duracionMs = finishedAt.getTime() - startedAt.getTime();
      const mensajeError = err instanceof Error ? err.message : String(err);

      if (controlRecordId && (prisma as any).controlSincronizacionLotes) {
        try {
          await (prisma as any).controlSincronizacionLotes.update({
            where: { id: controlRecordId },
            data: {
              finalizadoEn: finishedAt,
              duracionMs,
              estado: 'FALLIDO',
              mensajeError: mensajeError.slice(0, 1000),
            },
          });
        } catch {
          // Ignorar fallo de log en BD
        }
      }

      syncLogger.log({
        proceso: 'LOTES_SYNC',
        nivel: 'ERROR',
        timestamp: finishedAt.toISOString(),
        mensaje: `Fallo crítico en ciclo de sincronización de lotes: ${mensajeError}`,
        ejecucionUuid: cycleId,
        origenDisparador: trigger,
        archivo: 'Calidad Datos Base.csv',
        duracionMs,
        estado: 'FALLIDO',
        error: mensajeError,
      });

      this.scheduleRetry(30 * 60 * 1000, options);
      throw err;
    } finally {
      clearInterval(heartbeatTimer);
      this.isRunningInMemory = false;
      this.currentCycleId = null;
      this.currentTrigger = null;
      this.currentOwnerUuid = null;
      this.currentStartedAt = null;
      this.currentAbortReason = null;
      this.activeCyclePromise = null;
      await legacySyncLockService.releaseLock(GLOBAL_LOTES_LOCK_KEY, ownerUuid);
    }
  }

  async runCycle(
    trigger: LotesSyncTriggerSource,
    options: ImportLotesOptions = {}
  ): Promise<LotesSyncCycleOutcome> {
    const startedAt = new Date();
    const cycleId = crypto.randomUUID();

    if (this.isShuttingDown) {
      return {
        cycleId,
        trigger,
        skipped: true,
        skipReason: 'SHUTTING_DOWN',
        startedAt,
        finishedAt: new Date(),
      };
    }

    if (this.isRunningInMemory) {
      logger.warn({ trigger, cycleId }, 'Sincronización de lotes omitida: ya existe una ejecución activa en memoria.');
      return {
        cycleId,
        trigger,
        skipped: true,
        skipReason: 'ALREADY_RUNNING_IN_MEMORY',
        startedAt,
        finishedAt: new Date(),
      };
    }

    const lockTtlMs = 180_000;
    const ownerUuid = legacySyncLockService.generateOwnerUuid();
    const acquiredGlobal = await legacySyncLockService.acquireLock(
      GLOBAL_LOTES_LOCK_KEY,
      ownerUuid,
      lockTtlMs
    );

    if (!acquiredGlobal) {
      logger.warn({ trigger, cycleId }, 'Sincronización de lotes omitida: otra instancia mantiene el bloqueo de lotes.');
      return {
        cycleId,
        trigger,
        skipped: true,
        skipReason: 'GLOBAL_LOCK_HELD',
        startedAt,
        finishedAt: new Date(),
      };
    }

    try {
      const promise = this.executeLockedCycle(cycleId, trigger, ownerUuid, startedAt, options);
      this.activeCyclePromise = promise;
      return await promise;
    } catch (err: any) {
      this.scheduleRetry(30 * 60 * 1000, options);
      throw err;
    }
  }

  async startAsyncManualRun(options: ImportLotesOptions = {}): Promise<AsyncLotesManualRunTicket> {
    const startedAt = new Date();
    const cycleId = crypto.randomUUID();
    const trigger: LotesSyncTriggerSource = 'MANUAL_API';

    if (this.isShuttingDown) {
      return { accepted: false, cycleId, trigger, startedAt, skipReason: 'SHUTTING_DOWN' };
    }
    if (this.isRunningInMemory) {
      return { accepted: false, cycleId, trigger, startedAt, skipReason: 'ALREADY_RUNNING_IN_MEMORY' };
    }

    const lockTtlMs = 180_000;
    const ownerUuid = legacySyncLockService.generateOwnerUuid();
    const acquired = await legacySyncLockService.acquireLock(GLOBAL_LOTES_LOCK_KEY, ownerUuid, lockTtlMs);

    if (!acquired) {
      return { accepted: false, cycleId, trigger, startedAt, skipReason: 'GLOBAL_LOCK_HELD' };
    }

    this.isRunningInMemory = true;
    this.currentCycleId = cycleId;
    this.currentTrigger = trigger;
    this.currentOwnerUuid = ownerUuid;
    this.currentStartedAt = startedAt;

    const completionPromise = this.executeLockedCycle(cycleId, trigger, ownerUuid, startedAt, options);
    this.activeCyclePromise = completionPromise;

    return {
      accepted: true,
      cycleId,
      ownerUuid,
      trigger,
      startedAt,
      completionPromise,
    };
  }

  /**
   * Recuperación al arranque: verifica si ya hubo una ejecución EXITOSA de lotes posterior
   * al corte de las 06:00 AM de hoy. Si no hubo ninguna, la ejecuta inmediatamente.
   */
  async checkAndRecoverMissedRun(
    options: ImportLotesOptions & { referenceNow?: Date; trigger?: LotesSyncTriggerSource } = {}
  ): Promise<LotesRecoveryOutcome> {
    const now = options.referenceNow ?? new Date();
    const cutoffUtc = this.getLastScheduledCutoffUtc(now, 6, 0, this.timeZone);

    if (this.isShuttingDown || this.isRunningInMemory) {
      return { cutoffUtc, recoveryTriggered: false };
    }

    const globalLock = await legacySyncLockService.getLockState(GLOBAL_LOTES_LOCK_KEY);
    const isLocked =
      globalLock &&
      globalLock.propietarioUuid !== null &&
      globalLock.expiraEn !== null &&
      globalLock.expiraEn.getTime() > now.getTime();

    if (isLocked) {
      logger.info({ cutoffUtc }, 'Recuperación de lotes en arranque omitida: bloqueo activo por otra instancia.');
      return { cutoffUtc, recoveryTriggered: false };
    }

    // Verificar si ya hubo ejecución exitosa desde cutoffUtc
    let yaEjecutadoExitoso = false;
    try {
      if ((prisma as any).controlSincronizacionLotes) {
        const lastSuccess = await (prisma as any).controlSincronizacionLotes.findFirst({
          where: {
            estado: 'EXITOSO',
            iniciadoEn: { gte: cutoffUtc },
          },
          orderBy: { iniciadoEn: 'desc' },
        });
        if (lastSuccess) {
          yaEjecutadoExitoso = true;
        }
      }
    } catch {
      // Si la tabla no existe aún, procedemos con precaución
    }

    if (yaEjecutadoExitoso) {
      this.cancelRetry();
      logger.info(
        { cutoffUtc: cutoffUtc.toISOString() },
        'Verificación de arranque: el catálogo de lotes ya sincronizó exitosamente después del corte de las 06:00 AM.'
      );
      return { cutoffUtc, recoveryTriggered: false };
    }

    logger.warn(
      { cutoffUtc: cutoffUtc.toISOString() },
      'Verificación de arranque: no se detectó ejecución exitosa de lotes desde las 06:00 AM. Ejecutando actualización de recuperación...'
    );

    const cycleOutcome = await this.runCycle(options.trigger ?? 'RECOVERY_MISSED_RUN', options);

    return {
      cutoffUtc,
      recoveryTriggered: !cycleOutcome.skipped,
      cycleOutcome,
    };
  }

  async initializeBackendScheduler(
    options: {
      cronExpression?: string;
      timeZone?: string;
      importOptions?: ImportLotesOptions;
      runRecoveryOnStart?: boolean;
      awaitRecovery?: boolean;
    } = {}
  ): Promise<{ alreadyInitialized: boolean; recoveryPromise?: Promise<LotesRecoveryOutcome> }> {
    if (this.isInitialized && this.task !== null) {
      logger.warn('LotesSyncSchedulerService invocado nuevamente: se ignora para garantizar inicialización única.');
      return { alreadyInitialized: true };
    }

    this.isShuttingDown = false;
    this.startScheduler({
      cronExpression: options.cronExpression,
      timeZone: options.timeZone,
      importOptions: options.importOptions,
    });
    this.isInitialized = true;

    const shouldRecover = options.runRecoveryOnStart ?? true;
    if (!shouldRecover) {
      return { alreadyInitialized: false };
    }

    const recoveryPromise = this.checkAndRecoverMissedRun(options.importOptions).catch(err => {
      logger.error({ err }, 'Error durante la recuperación automática de arranque de lotes');
      throw err;
    });

    if (options.awaitRecovery) {
      await recoveryPromise;
    }

    return { alreadyInitialized: false, recoveryPromise };
  }

  startScheduler(
    customOptions: {
      cronExpression?: string;
      timeZone?: string;
      importOptions?: ImportLotesOptions;
    } = {}
  ): ScheduledTask {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }

    const expr = customOptions.cronExpression || this.cronExpression;
    const tz = customOptions.timeZone || this.timeZone;

    if (!this.validateExpression(expr)) {
      throw new Error(`Expresión cron inválida para lotes: "${expr}"`);
    }

    this.cronExpression = expr;
    this.timeZone = tz;
    this.isShuttingDown = false;

    this.task = cron.schedule(
      expr,
      () => {
        this.runCycle('CRON_SCHEDULED', customOptions.importOptions).catch(err => {
          logger.error({ err }, 'Error no capturado en ciclo programado de actualización de lotes');
        });
      },
      { timezone: tz }
    );

    this.isInitialized = true;

    logger.info(
      {
        cronExpression: this.cronExpression,
        timeZone: this.timeZone,
        nextRunUtc: this.getNextScheduledRun()?.toISOString() ?? null,
      },
      'Planificador automático de Lotes (06:00 AM) iniciado correctamente en el backend.'
    );

    return this.task;
  }

  stopScheduler(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info('Planificador automático de Lotes detenido.');
    }
    this.isInitialized = false;
  }

  async gracefulShutdown(maxWaitMs = 5000): Promise<{ completedCleanly: boolean; interrupted: boolean }> {
    this.isShuttingDown = true;
    this.cancelRetry();
    const ownerAtShutdown = this.currentOwnerUuid;

    if (this.task) {
      this.task.stop();
      this.task = null;
    }
    this.isInitialized = false;

    if (!this.activeCyclePromise) {
      return { completedCleanly: true, interrupted: false };
    }

    logger.info({ maxWaitMs, cycleId: this.currentCycleId }, 'Esperando a que finalice la sincronización de lotes en curso...');

    let timedOut = false;
    await Promise.race([
      this.activeCyclePromise.catch(() => undefined),
      new Promise<void>(resolve => {
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, maxWaitMs);
      }),
    ]);

    if (!timedOut) {
      return { completedCleanly: true, interrupted: false };
    }

    this.currentAbortReason = 'INTERRUPCION_APAGADO_SERVIDOR: Tiempo de espera agotado al apagar el backend.';
    if (ownerAtShutdown) {
      await legacySyncLockService.releaseLock(GLOBAL_LOTES_LOCK_KEY, ownerAtShutdown);
    }

    return { completedCleanly: false, interrupted: true };
  }

  getNextScheduledRun(): Date | null {
    if (!this.task) return null;
    const anyTask = this.task as any;
    if (typeof anyTask.getNextRun === 'function') {
      return anyTask.getNextRun();
    }
    return null;
  }

  getStatus() {
    return {
      initialized: this.isInitialized,
      schedulerActive: this.task !== null,
      shuttingDown: this.isShuttingDown,
      cronExpression: this.cronExpression,
      timeZone: this.timeZone,
      isRunningInMemory: this.isRunningInMemory,
      currentCycleId: this.currentCycleId,
      currentTrigger: this.currentTrigger,
      currentOwnerUuid: this.currentOwnerUuid,
      currentStartedAt: this.currentStartedAt,
      nextRunUtc: this.getNextScheduledRun(),
      proximoReintentoUtc: this.nextRetryAtUtc,
      intentosReintento: this.retryAttemptCount,
    };
  }

  async getDetailedStatus() {
    const now = new Date();
    const cutoffUtc = this.getLastScheduledCutoffUtc(now, 6, 0, this.timeZone);
    const nextRunUtc = this.getNextScheduledRun();

    const globalLock = await legacySyncLockService.getLockState(GLOBAL_LOTES_LOCK_KEY);
    const isGlobalLockActive = Boolean(
      globalLock &&
        globalLock.propietarioUuid !== null &&
        globalLock.expiraEn !== null &&
        globalLock.expiraEn.getTime() > now.getTime()
    );

    let recentExecutions: any[] = [];
    try {
      if ((prisma as any).controlSincronizacionLotes) {
        recentExecutions = await (prisma as any).controlSincronizacionLotes.findMany({
          orderBy: { iniciadoEn: 'desc' },
          take: 20,
        });
      }
    } catch {
      // Ignorar si tabla aún no existe
    }

    const lastExec = recentExecutions.length > 0 ? recentExecutions[0] : null;

    return {
      estadoActual: this.isRunningInMemory || isGlobalLockActive ? 'EN_PROCESO' : 'INACTIVO',
      scheduler: {
        initialized: this.isInitialized,
        schedulerActive: this.task !== null,
        shuttingDown: this.isShuttingDown,
        cronExpression: this.cronExpression,
        timeZone: this.timeZone,
        proximaEjecucionProgramada: nextRunUtc,
        ultimoCorteProgramadoUtc: cutoffUtc,
        proximoReintentoUtc: this.nextRetryAtUtc,
        intentosReintento: this.retryAttemptCount,
      },
      ejecucionActiva: {
        enMemoria: this.isRunningInMemory,
        bloqueoGlobalActivoEnBd: isGlobalLockActive,
        cycleId: this.currentCycleId,
        trigger: this.currentTrigger,
        propietarioUuid: this.currentOwnerUuid ?? (isGlobalLockActive ? globalLock?.propietarioUuid : null),
        iniciadoEn: this.currentStartedAt ?? (isGlobalLockActive ? globalLock?.adquiridoEn : null),
        expiraEn: isGlobalLockActive ? globalLock?.expiraEn : null,
      },
      ultimaEjecucion: lastExec
        ? {
            id: lastExec.id,
            ejecucionUuid: lastExec.ejecucionUuid,
            archivo: lastExec.archivo,
            rutaUtilizada: lastExec.rutaUtilizada,
            hashSha256: lastExec.hashSha256,
            tamanoBytes: lastExec.tamanoBytes ? Number(lastExec.tamanoBytes) : null,
            iniciadoEn: lastExec.iniciadoEn,
            finalizadoEn: lastExec.finalizadoEn,
            duracionMs: lastExec.duracionMs,
            origenDisparador: lastExec.origenDisparador,
            estado: lastExec.estado,
            registrosLeidos: lastExec.registrosLeidos,
            registrosInsertados: lastExec.registrosInsertados,
            registrosActualizados: lastExec.registrosActualizados,
            registrosOmitidos: lastExec.registrosOmitidos,
            registrosRechazados: lastExec.registrosRechazados,
            registrosInactivados: lastExec.registrosInactivados,
            mensajeError: lastExec.mensajeError,
          }
        : null,
    };
  }

  async getExecutionHistory(params: {
    page?: number;
    limit?: number;
    estado?: string;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 25));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (params.estado) where.estado = params.estado;

    try {
      if ((prisma as any).controlSincronizacionLotes) {
        const [total, items] = await Promise.all([
          (prisma as any).controlSincronizacionLotes.count({ where }),
          (prisma as any).controlSincronizacionLotes.findMany({
            where,
            orderBy: { iniciadoEn: 'desc' },
            skip,
            take: limit,
          }),
        ]);

        return {
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.max(1, Math.ceil(total / limit)),
          },
          items: items.map((item: any) => ({
            id: item.id,
            ejecucionUuid: item.ejecucionUuid,
            archivo: item.archivo,
            rutaUtilizada: item.rutaUtilizada,
            hashSha256: item.hashSha256,
            tamanoBytes: item.tamanoBytes ? Number(item.tamanoBytes) : null,
            fechaModificacionCsv: item.fechaModificacionCsv,
            iniciadoEn: item.iniciadoEn,
            finalizadoEn: item.finalizadoEn,
            duracionMs: item.duracionMs,
            origenDisparador: item.origenDisparador,
            estado: item.estado,
            registrosLeidos: item.registrosLeidos,
            registrosInsertados: item.registrosInsertados,
            registrosActualizados: item.registrosActualizados,
            registrosOmitidos: item.registrosOmitidos,
            registrosRechazados: item.registrosRechazados,
            registrosInactivados: item.registrosInactivados,
            mensajeError: item.mensajeError,
          })),
        };
      }
    } catch {
      // Ignorar si tabla no existe
    }

    return {
      pagination: { page, limit, total: 0, totalPages: 1 },
      items: [],
    };
  }
}

export const lotesSyncSchedulerService = new LotesSyncSchedulerService();

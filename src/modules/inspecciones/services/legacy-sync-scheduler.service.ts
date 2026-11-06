import crypto from 'crypto';
import cron, { type ScheduledTask } from 'node-cron';
import { prisma } from '../../../config/database';
import { logger } from '../../../utils/logger';
import {
  ARCHIVOS_PRODUCCION_LEGACY,
  type FileSyncResult,
  legacyIncrementalSyncService,
  type SyncOptions,
} from './legacy-incremental-sync.service';
import { legacySyncLockService } from './legacy-sync-lock.service';

export const DEFAULT_LEGACY_CRON_EXPRESSION = '0 2 * * *';
export const DEFAULT_LEGACY_CRON_TIMEZONE = 'America/Mexico_City';
export const GLOBAL_WORKER_LOCK_KEY = '__WORKER_GLOBAL_SYNC__';

export type SyncTriggerSource =
  | 'CRON_SCHEDULED'
  | 'RECOVERY_MISSED_RUN'
  | 'MANUAL_CLI'
  | 'MANUAL_API';

export interface SyncCycleOutcome {
  cycleId: string;
  trigger: SyncTriggerSource;
  ownerUuid?: string;
  skipped: boolean;
  skipReason?:
    | 'ALREADY_RUNNING_IN_MEMORY'
    | 'GLOBAL_LOCK_HELD'
    | 'NO_PENDING_FILES'
    | 'SHUTTING_DOWN';
  startedAt: Date;
  finishedAt: Date;
  results: FileSyncResult[];
}

export interface RecoveryCheckOutcome {
  cutoffUtc: Date;
  interruptedRunsCleaned: number;
  pendingFiles: string[];
  alreadyCompletedFiles: string[];
  recoveryTriggered: boolean;
  cycleOutcome?: SyncCycleOutcome;
}

export interface AsyncManualRunTicket {
  accepted: boolean;
  cycleId: string;
  ownerUuid?: string;
  trigger: SyncTriggerSource;
  startedAt: Date;
  targetFiles: string[];
  skipReason?: 'ALREADY_RUNNING_IN_MEMORY' | 'GLOBAL_LOCK_HELD' | 'SHUTTING_DOWN';
  completionPromise?: Promise<SyncCycleOutcome>;
}

/**
 * Servicio Integrado de Planificación, Coordinación, Estado y Recuperación Automática Legacy.
 *
 * Vive dentro del único proceso del backend de Calidad MBC (`defectos-calidad-api`):
 * 1. Garantiza inicialización única del scheduler `node-cron` (`0 2 * * *`, `America/Mexico_City`).
 * 2. Reutiliza `LegacyIncrementalSyncService` y `LegacySyncLockService` sin duplicar lógica.
 * 3. Previene ejecuciones simultáneas entre Cron, Recuperación, CLI y API mediante bloqueo en memoria
 *    y bloqueo global atómico en MySQL (`__WORKER_GLOBAL_SYNC__`).
 * 4. Monitorea el heartbeat y la propiedad del bloqueo: si el proceso pierde la propiedad del bloqueo
 *    global o por archivo, aborta la ejecución de forma segura antes de escribir datos.
 * 5. Ejecuta recuperación controlada por archivo tras reinicios o apagados prolongados.
 * 6. Coordina el apagado ordenado (`SIGINT`, `SIGTERM`, `PM2_SHUTDOWN_MSG`).
 */
export class LegacySyncSchedulerService {
  private task: ScheduledTask | null = null;
  private isInitialized = false;
  private isShuttingDown = false;
  private isRunningInMemory = false;
  private currentCycleId: string | null = null;
  private currentTrigger: SyncTriggerSource | null = null;
  private currentOwnerUuid: string | null = null;
  private currentStartedAt: Date | null = null;
  private currentAbortReason: string | null = null;
  private activeCyclePromise: Promise<SyncCycleOutcome> | null = null;
  private lastCycleOutcome: SyncCycleOutcome | null = null;

  private cronExpression: string =
    process.env.LEGACY_SYNC_CRON || DEFAULT_LEGACY_CRON_EXPRESSION;
  private timeZone: string = process.env.LEGACY_SYNC_TZ || DEFAULT_LEGACY_CRON_TIMEZONE;

  /**
   * Valida que la expresión cron sea sintácticamente válida para `node-cron`.
   */
  validateExpression(expr: string = this.cronExpression): boolean {
    return cron.validate(expr);
  }

  /**
   * Obtiene los componentes de fecha/hora locales en una zona horaria IANA específica.
   */
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

  /**
   * Convierte una fecha/hora local en `timeZone` a su instante `Date` UTC exacto.
   */
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
   * Calcula el instante UTC exacto de la última ventana diaria programada de las 02:00:00 AM
   * en la zona horaria `America/Mexico_City`.
   */
  getLastScheduledCutoffUtc(
    referenceUtc: Date = new Date(),
    targetHour = 2,
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
   * Limpia ejecuciones huérfanas que quedaron en estado `EN_PROCESO` porque el proceso
   * fue terminado abruptamente y cuyo bloqueo de archivo ya expiró o fue liberado.
   */
  async cleanupOrphanedExecutions(now: Date = new Date()): Promise<number> {
    const inProgressList = await prisma.controlSincronizacionLegacy.findMany({
      where: { estado: 'EN_PROCESO' },
    });

    if (inProgressList.length === 0) return 0;

    let cleaned = 0;
    for (const exec of inProgressList) {
      const fileLock = await legacySyncLockService.getLockState(exec.archivo);
      const isLockStillActive =
        fileLock &&
        fileLock.propietarioUuid !== null &&
        fileLock.expiraEn !== null &&
        fileLock.expiraEn.getTime() > now.getTime();

      if (!isLockStillActive) {
        await legacySyncLockService.failExecution(exec.id, {
          mensaje:
            'INTERRUPCION_REINICIO_BACKEND: Ejecución previa quedó EN_PROCESO sin bloqueo vigente tras reinicio.',
          detectedAt: now.toISOString(),
        });
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Verifica que el bloqueo global en MySQL siga perteneciendo a `ownerUuid` y no esté vencido.
   */
  private async verifyGlobalLockOwnership(ownerUuid: string): Promise<string | null> {
    if (this.currentAbortReason) {
      return this.currentAbortReason;
    }

    const lockState = await legacySyncLockService.getLockState(GLOBAL_WORKER_LOCK_KEY);
    const now = new Date();
    if (
      !lockState ||
      lockState.propietarioUuid !== ownerUuid ||
      !lockState.expiraEn ||
      lockState.expiraEn.getTime() <= now.getTime()
    ) {
      const reason =
        'BLOQUEO_PERDIDO_O_EXPIRADO: El proceso perdió la propiedad o vigencia del bloqueo global en MySQL.';
      this.currentAbortReason = reason;
      return reason;
    }

    return null;
  }

  /**
   * Ejecuta internamente el ciclo una vez adquirido el bloqueo global `ownerUuid`.
   */
  private async executeLockedCycle(
    cycleId: string,
    trigger: SyncTriggerSource,
    ownerUuid: string,
    startedAt: Date,
    options: SyncOptions
  ): Promise<SyncCycleOutcome> {
    const lockTtlMs = options.lockTtlMs ?? 120_000;
    this.isRunningInMemory = true;
    this.currentCycleId = cycleId;
    this.currentTrigger = trigger;
    this.currentOwnerUuid = ownerUuid;
    this.currentStartedAt = startedAt;
    this.currentAbortReason = null;

    // Heartbeat de renovación periódica del bloqueo global mientras dure la corrida
    const heartbeatMs = Math.max(250, Math.floor(lockTtlMs / 3));
    const heartbeatTimer = setInterval(() => {
      legacySyncLockService
        .renewLock(GLOBAL_WORKER_LOCK_KEY, ownerUuid, lockTtlMs)
        .then(renewed => {
          if (!renewed && !this.currentAbortReason) {
            this.currentAbortReason =
              'BLOQUEO_PERDIDO_O_EXPIRADO: Falló la renovación del heartbeat del bloqueo global.';
            logger.error(
              { cycleId, trigger, ownerUuid },
              'Se perdió el heartbeat del bloqueo global de sincronización; se abortará la escritura.'
            );
          }
        })
        .catch(err => {
          logger.warn({ err, cycleId }, 'Error transitorio al renovar heartbeat global');
        });
    }, heartbeatMs);

    try {
      logger.info(
        { cycleId, trigger, ownerUuid },
        'Iniciando ciclo de sincronización incremental Legacy...'
      );

      const combinedShouldAbort = async (): Promise<string | null> => {
        if (options.shouldAbort) {
          const customReason = await options.shouldAbort();
          if (customReason) return customReason;
        }
        return this.verifyGlobalLockOwnership(ownerUuid);
      };

      const results = await legacyIncrementalSyncService.syncAll({
        ...options,
        shouldAbort: combinedShouldAbort,
      });

      const finishedAt = new Date();
      const outcome: SyncCycleOutcome = {
        cycleId,
        trigger,
        ownerUuid,
        skipped: false,
        startedAt,
        finishedAt,
        results,
      };
      this.lastCycleOutcome = outcome;

      logger.info(
        {
          cycleId,
          trigger,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          resumen: results.map(r => ({
            archivo: r.archivo,
            estado: r.estado,
            insertados: r.registrosInsertados,
            actualizados: r.registrosActualizados,
            omitidos: r.registrosOmitidos,
            rechazados: r.registrosRechazados,
          })),
        },
        'Ciclo de sincronización incremental Legacy finalizado.'
      );

      return outcome;
    } finally {
      clearInterval(heartbeatTimer);
      this.isRunningInMemory = false;
      this.currentCycleId = null;
      this.currentTrigger = null;
      this.currentOwnerUuid = null;
      this.currentStartedAt = null;
      this.currentAbortReason = null;
      this.activeCyclePromise = null;
      // Liberar bloqueo global únicamente si sigue perteneciendo a este ownerUuid
      await legacySyncLockService.releaseLock(GLOBAL_WORKER_LOCK_KEY, ownerUuid);
    }
  }

  /**
   * Ejecuta un ciclo completo de sincronización protegido por bloqueo en memoria y bloqueo global en BD.
   */
  async runCycle(
    trigger: SyncTriggerSource,
    options: SyncOptions = {}
  ): Promise<SyncCycleOutcome> {
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
        results: [],
      };
    }

    if (this.isRunningInMemory) {
      logger.warn(
        { trigger, cycleId },
        'Sincronización omitida: ya existe una ejecución activa en memoria en este proceso.'
      );
      return {
        cycleId,
        trigger,
        skipped: true,
        skipReason: 'ALREADY_RUNNING_IN_MEMORY',
        startedAt,
        finishedAt: new Date(),
        results: [],
      };
    }

    const lockTtlMs = options.lockTtlMs ?? 120_000;
    const ownerUuid = legacySyncLockService.generateOwnerUuid();
    const acquiredGlobal = await legacySyncLockService.acquireLock(
      GLOBAL_WORKER_LOCK_KEY,
      ownerUuid,
      lockTtlMs
    );

    if (!acquiredGlobal) {
      logger.warn(
        { trigger, cycleId },
        'Sincronización omitida: otro proceso o instancia mantiene el bloqueo global activo.'
      );
      return {
        cycleId,
        trigger,
        skipped: true,
        skipReason: 'GLOBAL_LOCK_HELD',
        startedAt,
        finishedAt: new Date(),
        results: [],
      };
    }

    const promise = this.executeLockedCycle(cycleId, trigger, ownerUuid, startedAt, options);
    this.activeCyclePromise = promise;
    return promise;
  }

  /**
   * Inicia una ejecución manual administrativa desde la API adquiriendo primero el bloqueo
   * de forma atómica y ejecutando el trabajo en segundo plano sin bloquear la petición HTTP.
   */
  async startAsyncManualRun(options: SyncOptions = {}): Promise<AsyncManualRunTicket> {
    const startedAt = new Date();
    const cycleId = crypto.randomUUID();
    const trigger: SyncTriggerSource = 'MANUAL_API';

    const deptosWeb = legacyIncrementalSyncService.getDepartamentosEnModoWeb(
      options.departamentosWeb
    );
    const targetConfigs = (
      options.archivosFiltro
        ? ARCHIVOS_PRODUCCION_LEGACY.filter(c => options.archivosFiltro!.includes(c.archivo))
        : ARCHIVOS_PRODUCCION_LEGACY
    ).filter(c => !deptosWeb.has(c.departamentoCodigo));
    const targetFiles = targetConfigs.map(c => c.archivo);

    if (this.isShuttingDown) {
      return {
        accepted: false,
        cycleId,
        trigger,
        startedAt,
        targetFiles,
        skipReason: 'SHUTTING_DOWN',
      };
    }

    if (this.isRunningInMemory) {
      return {
        accepted: false,
        cycleId,
        trigger,
        startedAt,
        targetFiles,
        skipReason: 'ALREADY_RUNNING_IN_MEMORY',
      };
    }

    const lockTtlMs = options.lockTtlMs ?? 120_000;
    const ownerUuid = legacySyncLockService.generateOwnerUuid();
    const acquiredGlobal = await legacySyncLockService.acquireLock(
      GLOBAL_WORKER_LOCK_KEY,
      ownerUuid,
      lockTtlMs
    );

    if (!acquiredGlobal) {
      return {
        accepted: false,
        cycleId,
        trigger,
        startedAt,
        targetFiles,
        skipReason: 'GLOBAL_LOCK_HELD',
      };
    }

    // Marcar inmediatamente en memoria antes de devolver el ticket para evitar condiciones de carrera locales
    this.isRunningInMemory = true;
    this.currentCycleId = cycleId;
    this.currentTrigger = trigger;
    this.currentOwnerUuid = ownerUuid;
    this.currentStartedAt = startedAt;

    const completionPromise = this.executeLockedCycle(
      cycleId,
      trigger,
      ownerUuid,
      startedAt,
      options
    );
    this.activeCyclePromise = completionPromise;

    return {
      accepted: true,
      cycleId,
      ownerUuid,
      trigger,
      startedAt,
      targetFiles,
      completionPromise,
    };
  }

  /**
   * Verifica al arranque/reinicio del backend si la corrida programada de las 02:00 AM
   * (`America/Mexico_City`) fue omitida o quedó parcial/incompleta, ejecutando únicamente los
   * departamentos LEGACY pendientes.
   *
   * Regla fundamental: una ejecución parcial NO marca como completado el ciclo; se reintentan
   * exclusivamente los archivos que no tengan estado EXITOSO desde el último corte de las 02:00 AM.
   */
  async checkAndRecoverMissedRun(
    options: SyncOptions & { referenceNow?: Date } = {}
  ): Promise<RecoveryCheckOutcome> {
    const now = options.referenceNow ?? new Date();
    const cutoffUtc = this.getLastScheduledCutoffUtc(now, 2, 0, this.timeZone);

    if (this.isShuttingDown || this.isRunningInMemory) {
      return {
        cutoffUtc,
        interruptedRunsCleaned: 0,
        pendingFiles: [],
        alreadyCompletedFiles: [],
        recoveryTriggered: false,
      };
    }

    // 1. Verificar si hay un bloqueo global activo de otra instancia en curso antes de limpiar
    const globalLock = await legacySyncLockService.getLockState(GLOBAL_WORKER_LOCK_KEY);
    const isGlobalLocked =
      globalLock &&
      globalLock.propietarioUuid !== null &&
      globalLock.expiraEn !== null &&
      globalLock.expiraEn.getTime() > now.getTime();

    if (isGlobalLocked) {
      logger.info(
        { cutoffUtc, propietarioActual: globalLock.propietarioUuid },
        'Recuperación en arranque omitida: otra instancia tiene un ciclo activo en curso.'
      );
      return {
        cutoffUtc,
        interruptedRunsCleaned: 0,
        pendingFiles: [],
        alreadyCompletedFiles: [],
        recoveryTriggered: false,
      };
    }

    // 2. Limpiar ejecuciones huérfanas que quedaron EN_PROCESO sin bloqueo activo
    const interruptedRunsCleaned = await this.cleanupOrphanedExecutions(now);

    // 3. Determinar qué archivos corresponden a departamentos que siguen en modo LEGACY
    const deptosWeb = legacyIncrementalSyncService.getDepartamentosEnModoWeb(
      options.departamentosWeb
    );
    const targetConfigs = (
      options.archivosFiltro
        ? ARCHIVOS_PRODUCCION_LEGACY.filter(c => options.archivosFiltro!.includes(c.archivo))
        : ARCHIVOS_PRODUCCION_LEGACY
    ).filter(c => !deptosWeb.has(c.departamentoCodigo));

    const targetFiles = targetConfigs.map(c => c.archivo);
    if (targetFiles.length === 0) {
      return {
        cutoffUtc,
        interruptedRunsCleaned,
        pendingFiles: [],
        alreadyCompletedFiles: [],
        recoveryTriggered: false,
      };
    }

    // 4. Comprobar archivo por archivo si su última ejecución posterior al corte de las 02:00 AM fue EXITOSA
    const runsSinceCutoff = await prisma.controlSincronizacionLegacy.findMany({
      where: {
        archivo: { in: targetFiles },
        iniciadoEn: { gte: cutoffUtc },
      },
      orderBy: { iniciadoEn: 'desc' },
      select: {
        archivo: true,
        estado: true,
        iniciadoEn: true,
      },
    });

    // Un archivo solo se considera completado si tiene al menos una ejecución EXITOSA desde el corte
    // y no quedó únicamente con intentos FALLIDOS o EN_PROCESO
    const completedSet = new Set<string>();
    for (const run of runsSinceCutoff) {
      if (run.estado === 'EXITOSO') {
        completedSet.add(run.archivo);
      }
    }

    const alreadyCompletedFiles = targetFiles.filter(f => completedSet.has(f));
    const pendingFiles = targetFiles.filter(f => !completedSet.has(f));

    if (pendingFiles.length === 0) {
      logger.info(
        { cutoffUtc: cutoffUtc.toISOString(), alreadyCompletedFiles },
        'Verificación de arranque: todos los departamentos LEGACY ya sincronizaron exitosamente después del último corte programado (02:00 America/Mexico_City).'
      );
      return {
        cutoffUtc,
        interruptedRunsCleaned,
        pendingFiles: [],
        alreadyCompletedFiles,
        recoveryTriggered: false,
      };
    }

    logger.warn(
      {
        cutoffUtc: cutoffUtc.toISOString(),
        pendingFiles,
        alreadyCompletedFiles,
      },
      'Verificación de arranque: se detectaron departamentos LEGACY pendientes desde el último corte de las 02:00 AM. Ejecutando recuperación controlada...'
    );

    const cycleOutcome = await this.runCycle('RECOVERY_MISSED_RUN', {
      ...options,
      archivosFiltro: pendingFiles,
    });

    return {
      cutoffUtc,
      interruptedRunsCleaned,
      pendingFiles,
      alreadyCompletedFiles,
      recoveryTriggered: !cycleOutcome.skipped,
      cycleOutcome,
    };
  }

  /**
   * Inicializa el ciclo de vida integrado del scheduler en el backend exactamente una vez.
   * Protegido contra múltiples llamadas para evitar registrar más de un cron job.
   */
  async initializeBackendScheduler(
    options: {
      cronExpression?: string;
      timeZone?: string;
      syncOptions?: SyncOptions;
      runRecoveryOnStart?: boolean;
      awaitRecovery?: boolean;
    } = {}
  ): Promise<{ alreadyInitialized: boolean; recoveryPromise?: Promise<RecoveryCheckOutcome> }> {
    if (this.isInitialized && this.task !== null) {
      logger.warn(
        'LegacySyncSchedulerService.initializeBackendScheduler() invocado nuevamente: se ignora para garantizar inicialización única.'
      );
      return { alreadyInitialized: true };
    }

    this.isShuttingDown = false;
    this.startScheduler({
      cronExpression: options.cronExpression,
      timeZone: options.timeZone,
      syncOptions: options.syncOptions,
    });
    this.isInitialized = true;

    const shouldRecover = options.runRecoveryOnStart ?? true;
    if (!shouldRecover) {
      return { alreadyInitialized: false };
    }

    const recoveryPromise = this.checkAndRecoverMissedRun(options.syncOptions).catch(err => {
      logger.error({ err }, 'Error durante la recuperación automática de arranque Legacy');
      throw err;
    });

    if (options.awaitRecovery) {
      await recoveryPromise;
    }

    return {
      alreadyInitialized: false,
      recoveryPromise,
    };
  }

  /**
   * Inicia el planificador `node-cron` con la expresión `0 2 * * *` y zona horaria `America/Mexico_City`.
   */
  startScheduler(
    customOptions: {
      cronExpression?: string;
      timeZone?: string;
      syncOptions?: SyncOptions;
    } = {}
  ): ScheduledTask {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }

    const expr = customOptions.cronExpression || this.cronExpression;
    const tz = customOptions.timeZone || this.timeZone;

    if (!this.validateExpression(expr)) {
      throw new Error(`Expresión cron inválida: "${expr}"`);
    }

    this.cronExpression = expr;
    this.timeZone = tz;
    this.isShuttingDown = false;

    this.task = cron.schedule(
      expr,
      () => {
        this.runCycle('CRON_SCHEDULED', customOptions.syncOptions).catch(err => {
          logger.error({ err }, 'Error no capturado en ciclo programado de sincronización Legacy');
        });
      },
      {
        timezone: tz,
      }
    );

    this.isInitialized = true;

    logger.info(
      {
        cronExpression: this.cronExpression,
        timeZone: this.timeZone,
        nextRunUtc: this.getNextScheduledRun()?.toISOString() ?? null,
      },
      'Planificador automático Legacy integrado iniciado correctamente en el backend.'
    );

    return this.task;
  }

  /**
   * Detiene el planificador `node-cron` de forma limpia.
   */
  stopScheduler(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info('Planificador automático Legacy detenido.');
    }
    this.isInitialized = false;
  }

  /**
   * Apagado ordenado del scheduler integrado:
   * 1. Deja de aceptar nuevas ejecuciones.
   * 2. Detiene el cron job.
   * 3. Si hay una ejecución activa en este proceso, espera hasta `maxWaitMs` a que concluya.
   * 4. Si no termina a tiempo, activa la señal de aborto e interrupción, registra el fallo en
   *    los registros EN_PROCESO propios y libera únicamente los bloqueos pertenecientes a este proceso.
   */
  async gracefulShutdown(maxWaitMs = 5000): Promise<{
    completedCleanly: boolean;
    interrupted: boolean;
  }> {
    this.isShuttingDown = true;
    const ownerAtShutdown = this.currentOwnerUuid;

    if (this.task) {
      this.task.stop();
      this.task = null;
    }
    this.isInitialized = false;

    if (!this.activeCyclePromise) {
      return { completedCleanly: true, interrupted: false };
    }

    logger.info(
      { maxWaitMs, cycleId: this.currentCycleId },
      'Esperando a que finalice la sincronización Legacy en curso antes de apagar el backend...'
    );

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

    // Si el tiempo de espera se agotó, señalizar aborto inmediato para detener cualquier escritura pendiente
    this.currentAbortReason =
      'INTERRUPCION_APAGADO_SERVIDOR: Tiempo de espera agotado durante el apagado ordenado del backend.';
    logger.warn(
      { cycleId: this.currentCycleId, ownerAtShutdown },
      'La sincronización activa no concluyó dentro del tiempo de apagado; registrando interrupción y liberando bloqueo propio.'
    );

    // Esperar brevemente a que la transacción reaccione a currentAbortReason
    await Promise.race([
      this.activeCyclePromise.catch(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, 500)),
    ]);

    if (ownerAtShutdown) {
      await legacySyncLockService.releaseLock(GLOBAL_WORKER_LOCK_KEY, ownerAtShutdown);
    }

    return { completedCleanly: false, interrupted: true };
  }

  /**
   * Devuelve la fecha UTC de la próxima ejecución programada por `node-cron`.
   */
  getNextScheduledRun(): Date | null {
    if (!this.task) return null;
    const anyTask = this.task as any;
    if (typeof anyTask.getNextRun === 'function') {
      return anyTask.getNextRun();
    }
    return null;
  }

  /**
   * Estado ligero en memoria del scheduler.
   */
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
    };
  }

  /**
   * Estado administrativo completo (para `GET /api/v1/admin/legacy-sync/status`).
   */
  async getDetailedStatus() {
    const now = new Date();
    const cutoffUtc = this.getLastScheduledCutoffUtc(now, 2, 0, this.timeZone);
    const nextRunUtc = this.getNextScheduledRun();
    const deptosWebSet = legacyIncrementalSyncService.getDepartamentosEnModoWeb();

    const globalLock = await legacySyncLockService.getLockState(GLOBAL_WORKER_LOCK_KEY);
    const isGlobalLockActive = Boolean(
      globalLock &&
        globalLock.propietarioUuid !== null &&
        globalLock.expiraEn !== null &&
        globalLock.expiraEn.getTime() > now.getTime()
    );

    const recentExecutions = await prisma.controlSincronizacionLegacy.findMany({
      orderBy: { iniciadoEn: 'desc' },
      take: 25,
    });

    const latestByFile = new Map<string, (typeof recentExecutions)[number]>();
    for (const ex of recentExecutions) {
      if (!latestByFile.has(ex.archivo)) {
        latestByFile.set(ex.archivo, ex);
      }
    }

    const departamentosConfig = ARCHIVOS_PRODUCCION_LEGACY.map(cfg => {
      const modo = deptosWebSet.has(cfg.departamentoCodigo) ? 'WEB' : 'LEGACY';
      const lastExec = latestByFile.get(cfg.archivo) || null;
      return {
        departamento: cfg.departamentoCodigo,
        archivo: cfg.archivo,
        modo,
        ultimaEjecucion: lastExec
          ? {
              id: lastExec.id,
              ejecucionUuid: lastExec.ejecucionUuid,
              estado: lastExec.estado,
              iniciadoEn: lastExec.iniciadoEn,
              finalizadoEn: lastExec.finalizadoEn,
              registrosDetectados: lastExec.registrosDetectados,
              registrosInsertados: lastExec.registrosInsertados,
              registrosActualizados: lastExec.registrosActualizados,
              registrosOmitidos: lastExec.registrosOmitidos,
              registrosRechazados: lastExec.registrosRechazados,
              erroresCount: lastExec.erroresCount,
              detalleErrores: lastExec.detalleErrores,
            }
          : null,
      };
    });

    const departamentosWeb = departamentosConfig
      .filter(d => d.modo === 'WEB')
      .map(d => d.departamento);
    const departamentosLegacy = departamentosConfig
      .filter(d => d.modo === 'LEGACY')
      .map(d => d.departamento);

    // Construir resumen de la última ejecución (desde memoria o desde los últimos registros en BD)
    let ultimaEjecucionResumen: {
      cycleId: string | null;
      trigger: SyncTriggerSource | 'HISTORICO_BD';
      iniciadoEn: Date | null;
      finalizadoEn: Date | null;
      archivosProcesados: number;
      registrosDetectados: number;
      registrosInsertados: number;
      registrosActualizados: number;
      registrosOmitidos: number;
      registrosRechazados: number;
      erroresCount: number;
      archivos: Array<{
        archivo: string;
        departamento: string;
        estado: string;
        registrosInsertados: number;
        registrosActualizados: number;
        registrosOmitidos: number;
        registrosRechazados: number;
        erroresCount: number;
        mensajeError?: string;
      }>;
    } | null = null;

    if (this.lastCycleOutcome) {
      const res = this.lastCycleOutcome.results;
      ultimaEjecucionResumen = {
        cycleId: this.lastCycleOutcome.cycleId,
        trigger: this.lastCycleOutcome.trigger,
        iniciadoEn: this.lastCycleOutcome.startedAt,
        finalizadoEn: this.lastCycleOutcome.finishedAt,
        archivosProcesados: res.filter(r => !r.omitidoPorModoWeb).length,
        registrosDetectados: res.reduce((acc, r) => acc + r.registrosDetectados, 0),
        registrosInsertados: res.reduce((acc, r) => acc + r.registrosInsertados, 0),
        registrosActualizados: res.reduce((acc, r) => acc + r.registrosActualizados, 0),
        registrosOmitidos: res.reduce((acc, r) => acc + r.registrosOmitidos, 0),
        registrosRechazados: res.reduce((acc, r) => acc + r.registrosRechazados, 0),
        erroresCount: res.reduce((acc, r) => acc + r.erroresCount, 0),
        archivos: res.map(r => ({
          archivo: r.archivo,
          departamento: r.departamento,
          estado: r.estado,
          registrosInsertados: r.registrosInsertados,
          registrosActualizados: r.registrosActualizados,
          registrosOmitidos: r.registrosOmitidos,
          registrosRechazados: r.registrosRechazados,
          erroresCount: r.erroresCount,
          mensajeError: r.mensajeError,
        })),
      };
    } else if (latestByFile.size > 0) {
      const latestArr = Array.from(latestByFile.values());
      const startTimes = latestArr.map(r => r.iniciadoEn.getTime());
      const endTimes = latestArr
        .map(r => r.finalizadoEn?.getTime())
        .filter((t): t is number => typeof t === 'number');

      ultimaEjecucionResumen = {
        cycleId: null,
        trigger: 'HISTORICO_BD',
        iniciadoEn: startTimes.length > 0 ? new Date(Math.min(...startTimes)) : null,
        finalizadoEn: endTimes.length > 0 ? new Date(Math.max(...endTimes)) : null,
        archivosProcesados: latestArr.length,
        registrosDetectados: latestArr.reduce((acc, r) => acc + r.registrosDetectados, 0),
        registrosInsertados: latestArr.reduce((acc, r) => acc + r.registrosInsertados, 0),
        registrosActualizados: latestArr.reduce((acc, r) => acc + r.registrosActualizados, 0),
        registrosOmitidos: latestArr.reduce((acc, r) => acc + r.registrosOmitidos, 0),
        registrosRechazados: latestArr.reduce((acc, r) => acc + r.registrosRechazados, 0),
        erroresCount: latestArr.reduce((acc, r) => acc + r.erroresCount, 0),
        archivos: latestArr.map(r => ({
          archivo: r.archivo,
          departamento: r.departamento,
          estado: r.estado,
          registrosInsertados: r.registrosInsertados,
          registrosActualizados: r.registrosActualizados,
          registrosOmitidos: r.registrosOmitidos,
          registrosRechazados: r.registrosRechazados,
          erroresCount: r.erroresCount,
        })),
      };
    }

    return {
      estadoActual:
        this.isRunningInMemory || isGlobalLockActive ? 'EN_PROCESO' : 'INACTIVO',
      scheduler: {
        initialized: this.isInitialized,
        schedulerActive: this.task !== null,
        shuttingDown: this.isShuttingDown,
        cronExpression: this.cronExpression,
        timeZone: this.timeZone,
        proximaEjecucionProgramada: nextRunUtc,
        ultimoCorteProgramadoUtc: cutoffUtc,
      },
      ejecucionActiva: {
        enMemoria: this.isRunningInMemory,
        bloqueoGlobalActivoEnBd: isGlobalLockActive,
        cycleId: this.currentCycleId,
        trigger: this.currentTrigger,
        propietarioUuid:
          this.currentOwnerUuid ?? (isGlobalLockActive ? globalLock?.propietarioUuid : null),
        iniciadoEn:
          this.currentStartedAt ?? (isGlobalLockActive ? globalLock?.adquiridoEn : null),
        expiraEn: isGlobalLockActive ? globalLock?.expiraEn : null,
      },
      ultimaEjecucion: ultimaEjecucionResumen,
      departamentosWeb,
      departamentosLegacy,
      configuracionDepartamentos: departamentosConfig,
    };
  }

  /**
   * Historial paginado de auditoría de ejecuciones (para `GET /api/v1/admin/legacy-sync/history`).
   */
  async getExecutionHistory(params: {
    page?: number;
    limit?: number;
    archivo?: string;
    departamento?: string;
    estado?: 'EN_PROCESO' | 'EXITOSO' | 'FALLIDO';
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 25));
    const skip = (page - 1) * limit;

    const where: {
      archivo?: string;
      departamento?: string;
      estado?: 'EN_PROCESO' | 'EXITOSO' | 'FALLIDO';
    } = {};

    if (params.archivo) {
      where.archivo = params.archivo.trim();
    }
    if (params.departamento) {
      where.departamento = params.departamento.trim().toUpperCase();
    }
    if (params.estado) {
      where.estado = params.estado;
    }

    const [total, items] = await Promise.all([
      prisma.controlSincronizacionLegacy.count({ where }),
      prisma.controlSincronizacionLegacy.findMany({
        where,
        orderBy: { iniciadoEn: 'desc' },
        skip,
        take: limit,
        include: {
          _count: {
            select: { modificaciones: true },
          },
        },
      }),
    ]);

    return {
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      items: items.map(item => ({
        id: item.id,
        ejecucionUuid: item.ejecucionUuid,
        archivo: item.archivo,
        departamento: item.departamento,
        hashSha256Archivo: item.hashSha256Archivo,
        tamanoBytes: Number(item.tamanoBytes),
        fechaModificacionTxt: item.fechaModificacionTxt,
        iniciadoEn: item.iniciadoEn,
        finalizadoEn: item.finalizadoEn,
        registrosDetectados: item.registrosDetectados,
        registrosInsertados: item.registrosInsertados,
        registrosActualizados: item.registrosActualizados,
        registrosOmitidos: item.registrosOmitidos,
        registrosRechazados: item.registrosRechazados,
        erroresCount: item.erroresCount,
        detalleErrores: item.detalleErrores,
        estado: item.estado,
        modificacionesAuditadasCount: item._count.modificaciones,
      })),
    };
  }
}

export const legacySyncSchedulerService = new LegacySyncSchedulerService();

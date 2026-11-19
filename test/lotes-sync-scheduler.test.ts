import { describe, expect, test, afterAll } from 'bun:test';
import { prisma } from '../src/config/database';
import {
  DEFAULT_LOTES_CRON_EXPRESSION,
  DEFAULT_LOTES_CRON_TIMEZONE,
  GLOBAL_LOTES_LOCK_KEY,
  LotesSyncSchedulerService,
} from '../src/modules/lotes/services/lotes-sync-scheduler.service';
import { legacySyncLockService } from '../src/modules/inspecciones/services/legacy-sync-lock.service';
import { extraerModelo } from '../src/modules/lotes/services/lotes-import.service';

describe('Suite de Pruebas: Sincronización Automática de Lotes (06:00 AM)', () => {
  afterAll(async () => {
    // Limpieza de bloqueos
    await prisma.bloqueoSincronizacionLegacy.deleteMany({
      where: { archivo: GLOBAL_LOTES_LOCK_KEY },
    });
    await prisma.$disconnect();
  });

  test('1. Validación de expresión cron (0 6 * * *), zona horaria y cálculo del corte de las 06:00 AM', () => {
    const scheduler = new LotesSyncSchedulerService();
    expect(scheduler.validateExpression(DEFAULT_LOTES_CRON_EXPRESSION)).toBe(true);
    expect(DEFAULT_LOTES_CRON_EXPRESSION).toBe('0 6 * * *');
    expect(DEFAULT_LOTES_CRON_TIMEZONE).toBe('America/Mexico_City');

    // 1.1 Si son las 14:00 (hora México) del 19-Nov, el corte de las 06:00 AM debe ser hoy a las 06:00 AM (12:00 UTC)
    // 2026-11-19T20:00:00Z = 14:00 México
    const refTardeUtc = new Date('2026-11-19T20:00:00Z');
    const cutoffTarde = scheduler.getLastScheduledCutoffUtc(refTardeUtc, 6, 0, 'America/Mexico_City');
    expect(cutoffTarde.toISOString()).toBe('2026-11-19T12:00:00.000Z');

    // 1.2 Si son las 04:00 AM (hora México) del 19-Nov, el corte de las 06:00 AM fue ayer a las 06:00 AM (12:00 UTC del 18-Nov)
    // 2026-11-19T10:00:00Z = 04:00 México
    const refMananaTempranoUtc = new Date('2026-11-19T10:00:00Z');
    const cutoffManana = scheduler.getLastScheduledCutoffUtc(refMananaTempranoUtc, 6, 0, 'America/Mexico_City');
    expect(cutoffManana.toISOString()).toBe('2026-11-18T12:00:00.000Z');
  });

  test('2. Inicialización del scheduler y próxima ejecución UTC', () => {
    const scheduler = new LotesSyncSchedulerService();
    scheduler.startScheduler();

    const status = scheduler.getStatus();
    expect(status.initialized).toBe(true);
    expect(status.schedulerActive).toBe(true);
    expect(status.cronExpression).toBe('0 6 * * *');
    expect(status.timeZone).toBe('America/Mexico_City');
    expect(status.nextRunUtc).toBeInstanceOf(Date);

    // En UTC-6, las 06:00 AM locales corresponden a las 12:00 UTC
    const nextRun = status.nextRunUtc!;
    expect(nextRun.getUTCHours()).toBe(12);
    expect(nextRun.getUTCMinutes()).toBe(0);

    scheduler.stopScheduler();
    expect(scheduler.getStatus().schedulerActive).toBe(false);
  });

  test('3. Bloqueo distribuido atómico (__WORKER_LOTES_SYNC__) y prevención de concurrencia', async () => {
    // Asegurar que el bloqueo esté liberado
    await prisma.bloqueoSincronizacionLegacy.deleteMany({
      where: { archivo: GLOBAL_LOTES_LOCK_KEY },
    });

    const scheduler = new LotesSyncSchedulerService();

    // Simular que otro proceso adquirió el bloqueo distribuido de lotes
    const fakeOwner = legacySyncLockService.generateOwnerUuid();
    const lockAcquired = await legacySyncLockService.acquireLock(GLOBAL_LOTES_LOCK_KEY, fakeOwner, 60_000);
    expect(lockAcquired).toBe(true);

    try {
      // Intentar ejecutar un ciclo manual mientras el bloqueo está ocupado
      const ticket = await scheduler.startAsyncManualRun();
      expect(ticket.accepted).toBe(false);
      expect(ticket.skipReason).toBe('GLOBAL_LOCK_HELD');

      // Intentar ejecutar cycle directo
      const directOutcome = await scheduler.runCycle('CRON_SCHEDULED');
      expect(directOutcome.skipped).toBe(true);
      expect(directOutcome.skipReason).toBe('GLOBAL_LOCK_HELD');
    } finally {
      await legacySyncLockService.releaseLock(GLOBAL_LOTES_LOCK_KEY, fakeOwner);
    }

    // Verificar que una vez liberado, el bloqueo queda disponible
    const lockAfter = await legacySyncLockService.getLockState(GLOBAL_LOTES_LOCK_KEY);
    expect(lockAfter?.propietarioUuid).toBeNull();
  });

  test('4. Motor de reintentos automáticos cada 30 minutos', () => {
    const scheduler = new LotesSyncSchedulerService();

    // Programar reintento manual de prueba
    scheduler.scheduleRetry(30 * 60 * 1000);
    const status1 = scheduler.getStatus();
    expect(status1.intentosReintento).toBe(1);
    expect(status1.proximoReintentoUtc).toBeInstanceOf(Date);

    const diffMs = status1.proximoReintentoUtc!.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(29 * 60 * 1000);
    expect(diffMs).toBeLessThanOrEqual(30 * 60 * 1000 + 1000);

    // Cancelar reintento tras éxito
    scheduler.cancelRetry();
    const status2 = scheduler.getStatus();
    expect(status2.intentosReintento).toBe(0);
    expect(status2.proximoReintentoUtc).toBeNull();
  });

  test('5. Extracción y validación estricta de modelo según regla oficial', () => {
    // Prefijo 10 + 6 caracteres del modelo
    const res1 = extraerModelo('103Z2LPH9052CUH');
    expect(res1.modelo).toBe('3Z2LPH');
    expect(res1.error).toBeUndefined();

    // IdProducto que no inicia con 10
    const res2 = extraerModelo('203Z2LPH9052CUH');
    expect(res2.modelo).toBeNull();
    expect(res2.error).toContain("no inicia con prefijo estándar '10'");

    // IdProducto muy corto
    const res3 = extraerModelo('103Z');
    expect(res3.modelo).toBeNull();
    expect(res3.error).toContain('longitud insuficiente');
  });

  test('6. Apagado ordenado (gracefulShutdown) de LotesSyncScheduler', async () => {
    const scheduler = new LotesSyncSchedulerService();
    scheduler.startScheduler();
    scheduler.scheduleRetry(30 * 60 * 1000);

    expect(scheduler.getStatus().schedulerActive).toBe(true);
    expect(scheduler.getStatus().proximoReintentoUtc).not.toBeNull();

    const shutdown = await scheduler.gracefulShutdown(1000);
    expect(shutdown.completedCleanly).toBe(true);
    expect(shutdown.interrupted).toBe(false);

    const finalStatus = scheduler.getStatus();
    expect(finalStatus.schedulerActive).toBe(false);
    expect(finalStatus.shuttingDown).toBe(true);
    expect(finalStatus.proximoReintentoUtc).toBeNull();
  });
});

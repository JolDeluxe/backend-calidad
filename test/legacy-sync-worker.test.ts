import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'node:http';
import { createApp } from '../src/app';
import { prisma } from '../src/config/database';
import { securityService } from '../src/modules/auth/services/security.service';
import { legacySyncLockService } from '../src/modules/inspecciones/services/legacy-sync-lock.service';
import {
  DEFAULT_LEGACY_CRON_EXPRESSION,
  DEFAULT_LEGACY_CRON_TIMEZONE,
  GLOBAL_WORKER_LOCK_KEY,
  LegacySyncSchedulerService,
  legacySyncSchedulerService,
} from '../src/modules/inspecciones/services/legacy-sync-scheduler.service';

const HEADER_14 = [
  'No',
  'Departamento',
  'Fecha',
  'Lista',
  'Lote',
  'Linea',
  'Modelo',
  'Descripcion',
  'DefDepto',
  'Id',
  'Defecto',
  'Prs',
  'Horma',
  'Usuario',
].join('\t');

describe('Suite Integrada — Scheduler en Backend, Concurrencia, Recuperación, Apagado y API Admin', () => {
  let tempDir: string;
  let server: Server | null = null;
  let baseUrl = '';
  let superAdminToken = '';
  let inspectorToken = '';
  const createdSessionIds: number[] = [];

  const scheduler = new LegacySyncSchedulerService();
  const testNos = ['997001', '997002', '997003', '997004', '997005'];
  const testLoteCode = '997766';
  const createdExecutionIds: number[] = [];

  async function cleanupWorkerTestArtifacts() {
    scheduler.stopScheduler();
    legacySyncSchedulerService.stopScheduler();

    const testOrigens = await prisma.inspeccionHistoricaOrigen.findMany({
      where: {
        OR: [{ noOriginal: { in: testNos } }, { lote: testLoteCode }],
      },
      select: { id: true },
    });
    const origenIds = testOrigens.map(o => o.id);

    if (origenIds.length > 0) {
      await prisma.historicoModificacionLegacy.deleteMany({
        where: { historicoOrigenId: { in: origenIds } },
      });
      await prisma.inspeccionDetalle.deleteMany({
        where: { historicoOrigenId: { in: origenIds } },
      });
      await prisma.inspeccionHistoricaOrigen.deleteMany({
        where: { id: { in: origenIds } },
      });
    }

    const loteTest = await prisma.produccionLote.findUnique({
      where: { lote: testLoteCode },
      select: { id: true },
    });

    if (loteTest) {
      const cabecerasTest = await prisma.inspeccionCabecera.findMany({
        where: { loteId: loteTest.id },
        select: { id: true },
      });
      const cabIds = cabecerasTest.map(c => c.id);
      if (cabIds.length > 0) {
        await prisma.inspeccionDetalle.deleteMany({
          where: { inspeccionId: { in: cabIds } },
        });
        await prisma.inspeccionCabecera.deleteMany({
          where: { id: { in: cabIds } },
        });
      }
      await prisma.produccionLote.delete({
        where: { id: loteTest.id },
      });
    }

    if (createdExecutionIds.length > 0) {
      await prisma.historicoModificacionLegacy.deleteMany({
        where: { sincronizacionId: { in: createdExecutionIds } },
      });
      await prisma.controlSincronizacionLegacy.deleteMany({
        where: { id: { in: createdExecutionIds } },
      });
      createdExecutionIds.length = 0;
    }

    if (createdSessionIds.length > 0) {
      await prisma.sesion.deleteMany({
        where: { id: { in: createdSessionIds } },
      });
      createdSessionIds.length = 0;
    }

    await prisma.bloqueoSincronizacionLegacy.deleteMany({
      where: {
        archivo: {
          in: [GLOBAL_WORKER_LOCK_KEY, 'Defectos_Test_Orphan.txt'],
        },
      },
    });
  }

  beforeAll(async () => {
    await cleanupWorkerTestArtifacts();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc_integrated_scheduler_test_'));

    // Levantar servidor HTTP Express real en puerto efímero para probar las rutas /api/v1/admin/legacy-sync/*
    const app = createApp();
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });

    // Crear sesiones de prueba para SUPER_ADMIN (con permisos sincronizacion.*) e INSPECTOR (sin permisos admin)
    const superAdminUser = await prisma.usuario.findFirst({
      where: { rol: { codigo: 'SUPER_ADMIN' }, estado: 'ACTIVO' },
      include: { rol: true },
    });
    expect(superAdminUser).not.toBeNull();

    const inspectorUser = await prisma.usuario.findFirst({
      where: { rol: { codigo: 'INSPECTOR' }, estado: 'ACTIVO' },
      include: { rol: true },
    });
    expect(inspectorUser).not.toBeNull();

    const expDate = new Date(Date.now() + 3600_000);
    const adminSession = await prisma.sesion.create({
      data: {
        usuarioId: superAdminUser!.id,
        refreshTokenHash: `test_hash_admin_${Date.now()}_${Math.random()}`,
        estado: 'ACTIVO',
        fechaExpiracion: expDate,
      },
    });
    createdSessionIds.push(adminSession.id);

    superAdminToken = securityService.generateAccessToken({
      usuarioId: superAdminUser!.id,
      usuario: superAdminUser!.usuario,
      nombre: superAdminUser!.nombre,
      rolId: superAdminUser!.rolId,
      rolCodigo: superAdminUser!.rol.codigo,
      sesionId: adminSession.id,
    });

    const inspSession = await prisma.sesion.create({
      data: {
        usuarioId: inspectorUser!.id,
        refreshTokenHash: `test_hash_insp_${Date.now()}_${Math.random()}`,
        estado: 'ACTIVO',
        fechaExpiracion: expDate,
      },
    });
    createdSessionIds.push(inspSession.id);

    inspectorToken = securityService.generateAccessToken({
      usuarioId: inspectorUser!.id,
      usuario: inspectorUser!.usuario,
      nombre: inspectorUser!.nombre,
      rolId: inspectorUser!.rolId,
      rolCodigo: inspectorUser!.rol.codigo,
      sesionId: inspSession.id,
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = null;
    }
    await cleanupWorkerTestArtifacts();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('1. Inicialización única, programación 0 2 * * * y zona horaria America/Mexico_City', async () => {
    expect(scheduler.validateExpression(DEFAULT_LEGACY_CRON_EXPRESSION)).toBe(true);
    expect(scheduler.validateExpression('expresion_invalida')).toBe(false);

    // Primera inicialización del ciclo de vida integrado
    const init1 = await scheduler.initializeBackendScheduler({
      cronExpression: DEFAULT_LEGACY_CRON_EXPRESSION,
      timeZone: DEFAULT_LEGACY_CRON_TIMEZONE,
      runRecoveryOnStart: false,
    });
    expect(init1.alreadyInitialized).toBe(false);

    // Segunda llamada consecutiva: protección de inicialización única (no duplica el cron job)
    const init2 = await scheduler.initializeBackendScheduler({
      cronExpression: DEFAULT_LEGACY_CRON_EXPRESSION,
      timeZone: DEFAULT_LEGACY_CRON_TIMEZONE,
      runRecoveryOnStart: false,
    });
    expect(init2.alreadyInitialized).toBe(true);

    const status = scheduler.getStatus();
    expect(status.initialized).toBe(true);
    expect(status.schedulerActive).toBe(true);
    expect(status.cronExpression).toBe('0 2 * * *');
    expect(status.timeZone).toBe('America/Mexico_City');
    expect(status.nextRunUtc).toBeInstanceOf(Date);

    // En America/Mexico_City (UTC-6 estándar), las 02:00:00 locales corresponden a las 08:00:00 UTC
    const nextRunUtc = status.nextRunUtc!;
    expect(nextRunUtc.getUTCHours()).toBe(8);
    expect(nextRunUtc.getUTCMinutes()).toBe(0);
    expect(nextRunUtc.getUTCSeconds()).toBe(0);

    scheduler.stopScheduler();
    expect(scheduler.getStatus().schedulerActive).toBe(false);

    // Cálculo de corte horario antes y después de las 02:00 AM CDMX
    const refAfter2AmLocal = new Date('2026-11-06T16:30:00.000Z');
    const cutoffAfter = scheduler.getLastScheduledCutoffUtc(
      refAfter2AmLocal,
      2,
      0,
      'America/Mexico_City'
    );
    expect(cutoffAfter.toISOString()).toBe('2026-11-06T08:00:00.000Z');

    const refBefore2AmLocal = new Date('2026-11-06T07:15:00.000Z');
    const cutoffBefore = scheduler.getLastScheduledCutoffUtc(
      refBefore2AmLocal,
      2,
      0,
      'America/Mexico_City'
    );
    expect(cutoffBefore.toISOString()).toBe('2026-11-05T08:00:00.000Z');
  });

  test('2. Recuperación de ejecución omitida y recuperación de ejecución parcial tras reinicio', async () => {
    const bordadoPath = path.join(tempDir, 'Defectos_Bordado.txt');
    const prelimPath = path.join(tempDir, 'Defectos_Preliminares.txt');
    const pespuntePath = path.join(tempDir, 'Defectos_Pespunte.txt');

    const rowBordado = [
      '997001',
      'Bordado',
      '06 / 11 / 2026',
      '105',
      testLoteCode,
      'L1',
      '7F300',
      'BOTA TEST INTEGRADO',
      'CORTE',
      '1113',
      'Piel con falla zona A',
      '2',
      'H1',
      'LETICIA CONCEPCION',
    ].join('\t');

    const rowPrelim = [
      '997002',
      'Preliminares',
      '06 / 11 / 2026',
      '105',
      testLoteCode,
      'L1',
      '7F300',
      'BOTA TEST INTEGRADO',
      'CORTE',
      '1113',
      'Piel con falla zona A',
      '1',
      'H1',
      'LETICIA CONCEPCION',
    ].join('\t');

    const rowPespunte = [
      '997003',
      'Pespunte',
      '06 / 11 / 2026',
      '105',
      testLoteCode,
      'L1',
      '7F300',
      'BOTA TEST INTEGRADO',
      'CORTE',
      '1113',
      'Piel con falla zona A',
      '3',
      'H1',
      'FRANCISCO ARTURO GONZALEZ',
    ].join('\t');

    fs.writeFileSync(bordadoPath, `${HEADER_14}\r\n${rowBordado}\r\n`, 'latin1');
    fs.writeFileSync(prelimPath, `${HEADER_14}\r\n${rowPrelim}\r\n`, 'latin1');

    // Simulamos corte futuro (mañana a las 09:00 AM CDMX) donde aún no se ha corrido Bordado
    const simulatedFutureNow = new Date(Date.now() + 36 * 3600 * 1000);

    const recovery = await scheduler.checkAndRecoverMissedRun({
      baseDir: tempDir,
      archivosFiltro: ['Defectos_Bordado.txt', 'Defectos_Preliminares.txt'],
      departamentosWeb: ['PRELIMINARES'],
      referenceNow: simulatedFutureNow,
    });

    expect(recovery.recoveryTriggered).toBe(true);
    expect(recovery.pendingFiles).toEqual(['Defectos_Bordado.txt']);
    expect(recovery.cycleOutcome).toBeDefined();
    expect(recovery.cycleOutcome!.results[0].estado).toBe('EXITOSO');
    expect(recovery.cycleOutcome!.results[0].registrosInsertados).toBe(1);

    if (recovery.cycleOutcome!.results[0].sincronizacionId) {
      createdExecutionIds.push(recovery.cycleOutcome!.results[0].sincronizacionId);
    }

    // Ahora probamos RECUPERACIÓN PARCIAL:
    // En el corte actual de hoy, Defectos_Bordado.txt YA tiene ejecución EXITOSA,
    // pero creamos una ejecución FALLIDA para Defectos_Pespunte.txt posterior al corte de hoy.
    // Al reiniciar el backend, la recuperación debe detectar que Bordado ya está completo
    // y reintentar EXCLUSIVAMENTE Defectos_Pespunte.txt.
    fs.writeFileSync(pespuntePath, `${HEADER_14}\r\n${rowPespunte}\r\n`, 'latin1');

    const failedPespunteExec = await legacySyncLockService.startExecution({
      archivo: 'Defectos_Pespunte.txt',
      departamento: 'PESPUNTE',
      ejecucionUuid: legacySyncLockService.generateOwnerUuid(),
      hashSha256Archivo: '0'.repeat(64),
      tamanoBytes: 512,
      fechaModificacionTxt: new Date(),
    });
    await legacySyncLockService.failExecution(failedPespunteExec.id, {
      mensaje: 'FALLO_SIMULADO_PREVIO',
    });
    createdExecutionIds.push(failedPespunteExec.id);

    // Eliminamos cualquier ejecución EXITOSA previa de hoy de Defectos_Pespunte.txt si existiera?
    // Para no tocar registros reales de la BD de desarrollo, usamos un referenceNow cuyo cutoffUtc
    // sea exactamente hace 2 segundos (después de las corridas históricas de la BD pero antes de la corrida EXITOSA de Bordado).
    // Como Bordado corrió hace < 1 segundo, si tomamos un referenceNow cuyo cutoff sea anterior a Bordado,
    // o bien verificamos con Bordado (EXITOSO recién creado) y simulamos el corte:
    const bordadoExec = await prisma.controlSincronizacionLegacy.findUnique({
      where: { id: recovery.cycleOutcome!.results[0].sincronizacionId! },
    });
    expect(bordadoExec).not.toBeNull();

    // Actualizamos iniciadoEn de bordadoExec a mañana a las 08:05 UTC (después del corte de mañana 08:00 UTC)
    // y failedPespunteExec a mañana a las 08:06 UTC (FALLIDO después del corte de mañana 08:00 UTC)
    const tomorrowAfterCutoff = new Date(
      scheduler.getLastScheduledCutoffUtc(simulatedFutureNow, 2, 0, 'America/Mexico_City').getTime() +
        5 * 60_000
    );
    await prisma.controlSincronizacionLegacy.update({
      where: { id: bordadoExec!.id },
      data: { iniciadoEn: tomorrowAfterCutoff },
    });
    await prisma.controlSincronizacionLegacy.update({
      where: { id: failedPespunteExec.id },
      data: { iniciadoEn: new Date(tomorrowAfterCutoff.getTime() + 1000) },
    });

    const partialRecovery = await scheduler.checkAndRecoverMissedRun({
      baseDir: tempDir,
      archivosFiltro: ['Defectos_Bordado.txt', 'Defectos_Pespunte.txt'],
      departamentosWeb: ['PRELIMINARES'],
      referenceNow: simulatedFutureNow,
    });

    expect(partialRecovery.recoveryTriggered).toBe(true);
    expect(partialRecovery.alreadyCompletedFiles).toEqual(['Defectos_Bordado.txt']);
    expect(partialRecovery.pendingFiles).toEqual(['Defectos_Pespunte.txt']);
    expect(partialRecovery.cycleOutcome!.results.length).toBe(1);
    expect(partialRecovery.cycleOutcome!.results[0].archivo).toBe('Defectos_Pespunte.txt');
    expect(partialRecovery.cycleOutcome!.results[0].estado).toBe('EXITOSO');
    expect(partialRecovery.cycleOutcome!.results[0].registrosInsertados).toBe(1);

    const pespunteSuccessId = partialRecovery.cycleOutcome!.results[0].sincronizacionId!;
    createdExecutionIds.push(pespunteSuccessId);

    // Actualizar iniciadoEn de pespunteSuccessId también a tomorrowAfterCutoff para el siguiente test de no duplicación
    await prisma.controlSincronizacionLegacy.update({
      where: { id: pespunteSuccessId },
      data: { iniciadoEn: new Date(tomorrowAfterCutoff.getTime() + 2000) },
    });
  });

  test('3. No duplicación después de una ejecución exitosa al reiniciar el backend', async () => {
    const simulatedFutureNow = new Date(Date.now() + 36 * 3600 * 1000);

    const restartCheck = await scheduler.checkAndRecoverMissedRun({
      baseDir: tempDir,
      archivosFiltro: ['Defectos_Bordado.txt', 'Defectos_Pespunte.txt'],
      departamentosWeb: ['PRELIMINARES'],
      referenceNow: simulatedFutureNow,
    });

    expect(restartCheck.recoveryTriggered).toBe(false);
    expect(restartCheck.pendingFiles).toEqual([]);
    expect(restartCheck.alreadyCompletedFiles).toEqual([
      'Defectos_Bordado.txt',
      'Defectos_Pespunte.txt',
    ]);
    expect(restartCheck.cycleOutcome).toBeUndefined();
  });

  test('4. Recuperación de ejecuciones huérfanas EN_PROCESO tras reinicio abrupto', async () => {
    const orphanExec = await legacySyncLockService.startExecution({
      archivo: 'Defectos_Test_Orphan.txt',
      departamento: 'BORDADO_Y_LASER',
      ejecucionUuid: legacySyncLockService.generateOwnerUuid(),
      hashSha256Archivo: '0'.repeat(64),
      tamanoBytes: 1024,
      fechaModificacionTxt: new Date(),
    });
    createdExecutionIds.push(orphanExec.id);

    const cleanedCount = await scheduler.cleanupOrphanedExecutions(new Date());
    expect(cleanedCount).toBeGreaterThanOrEqual(1);

    const updatedOrphan = await prisma.controlSincronizacionLegacy.findUnique({
      where: { id: orphanExec.id },
    });
    expect(updatedOrphan).not.toBeNull();
    expect(updatedOrphan!.estado).toBe('FALLIDO');
    expect(JSON.stringify(updatedOrphan!.detalleErrores)).toContain(
      'INTERRUPCION_REINICIO_BACKEND'
    );
  });

  test('5. Concurrencia: Cron, Recuperación, CLI, API y dos instancias accidentales del backend no colisionan', async () => {
    const secondBackendInstance = new LegacySyncSchedulerService();
    const externalOwner = legacySyncLockService.generateOwnerUuid();

    const lockAcquired = await legacySyncLockService.acquireLock(
      GLOBAL_WORKER_LOCK_KEY,
      externalOwner,
      60_000
    );
    expect(lockAcquired).toBe(true);

    try {
      // 1. Cron en instancia 1
      const cronAttempt = await scheduler.runCycle('CRON_SCHEDULED', {
        baseDir: tempDir,
        archivosFiltro: ['Defectos_Bordado.txt'],
      });
      expect(cronAttempt.skipped).toBe(true);
      expect(cronAttempt.skipReason).toBe('GLOBAL_LOCK_HELD');

      // 2. CLI manual
      const cliAttempt = await scheduler.runCycle('MANUAL_CLI', {
        baseDir: tempDir,
        archivosFiltro: ['Defectos_Bordado.txt'],
      });
      expect(cliAttempt.skipped).toBe(true);
      expect(cliAttempt.skipReason).toBe('GLOBAL_LOCK_HELD');

      // 3. Recuperación en segunda instancia accidental del backend
      const secondInstanceRecovery = await secondBackendInstance.checkAndRecoverMissedRun({
        baseDir: tempDir,
        archivosFiltro: ['Defectos_Bordado.txt'],
      });
      expect(secondInstanceRecovery.recoveryTriggered).toBe(false);

      // 4. Solicitud administrativa desde API mientras el bloqueo global está activo
      const apiTicket = await secondBackendInstance.startAsyncManualRun({
        baseDir: tempDir,
        archivosFiltro: ['Defectos_Bordado.txt'],
      });
      expect(apiTicket.accepted).toBe(false);
      expect(apiTicket.skipReason).toBe('GLOBAL_LOCK_HELD');
    } finally {
      const released = await legacySyncLockService.releaseLock(
        GLOBAL_WORKER_LOCK_KEY,
        externalOwner
      );
      expect(released).toBe(true);
    }
  });

  test('6. Expiración de bloqueo y pérdida de heartbeat: aborta inmediatamente sin escribir datos si pierde propiedad', async () => {
    const aviosPath = path.join(tempDir, 'Defectos_Avios.txt');
    const rowAviosNew = [
      '997004',
      'Avios',
      '06 / 11 / 2026',
      '105',
      testLoteCode,
      '7F300',
      'BOTA TEST HEARTBEAT LOST',
      'CORTE',
      '1113',
      'Piel con falla zona A',
      '4',
      'H1',
      'LETICIA CONCEPCION',
      '',
    ].join('\t');
    fs.writeFileSync(aviosPath, `${HEADER_14}\r\n${rowAviosNew}\r\n`, 'latin1');

    // Durante la ejecución del ciclo, simulamos que el bloqueo global en MySQL fue invalidado/tomado por otro propietario
    let robbedLock = false;
    const outcome = await scheduler.runCycle('CRON_SCHEDULED', {
      baseDir: tempDir,
      archivosFiltro: ['Defectos_Avios.txt'],
      shouldAbort: async () => {
        if (!robbedLock) {
          robbedLock = true;
          await prisma.bloqueoSincronizacionLegacy.updateMany({
            where: { archivo: GLOBAL_WORKER_LOCK_KEY },
            data: { propietarioUuid: 'stolen-by-another-instance' },
          });
        }
        return null;
      },
    });

    expect(outcome.skipped).toBe(false);
    expect(outcome.results.length).toBe(1);
    expect(outcome.results[0].estado).toBe('FALLIDO');
    expect(outcome.results[0].mensajeError).toContain('BLOQUEO_PERDIDO_O_EXPIRADO');

    if (outcome.results[0].sincronizacionId) {
      createdExecutionIds.push(outcome.results[0].sincronizacionId);
    }

    // Verificar que el registro 997004 NO se escribió en MySQL tras perder la propiedad del bloqueo
    const abortedRow = await prisma.inspeccionHistoricaOrigen.findFirst({
      where: { archivoOrigen: 'Defectos_Avios.txt', noOriginal: '997004' },
    });
    expect(abortedRow).toBeNull();

    // Limpiar el propietario simulado en el bloqueo global
    await prisma.bloqueoSincronizacionLegacy.updateMany({
      where: { archivo: GLOBAL_WORKER_LOCK_KEY },
      data: { propietarioUuid: null, expiraEn: null },
    });
  });

  test('7. Rutas API Administrativas (/api/v1/admin/legacy-sync/*): autenticación, permisos, validación, status, history y run', async () => {
    // 7.1. Usuario no autenticado -> 401
    const unauthRes = await fetch(`${baseUrl}/api/v1/admin/legacy-sync/status`);
    expect(unauthRes.status).toBe(401);

    // 7.2. Usuario autenticado sin rol/permisos administrativos (INSPECTOR) -> 403
    const forbiddenRes = await fetch(`${baseUrl}/api/v1/admin/legacy-sync/status`, {
      headers: { Authorization: `Bearer ${inspectorToken}` },
    });
    expect(forbiddenRes.status).toBe(403);

    const forbiddenRunRes = await fetch(`${baseUrl}/api/v1/admin/legacy-sync/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${inspectorToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(forbiddenRunRes.status).toBe(403);

    // 7.3. Parámetros inválidos en POST /run y GET /history -> 400
    const invalidRunRes = await fetch(`${baseUrl}/api/v1/admin/legacy-sync/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${superAdminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ archivo: 'Archivo_Inexistente_Hack.txt' }),
    });
    expect(invalidRunRes.status).toBe(400);

    const invalidHistoryRes = await fetch(
      `${baseUrl}/api/v1/admin/legacy-sync/history?estado=ESTADO_INVALIDO`,
      {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      }
    );
    expect(invalidHistoryRes.status).toBe(400);

    // 7.4. GET /status con SUPER_ADMIN -> 200 OK y estructura completa
    const statusRes = await fetch(`${baseUrl}/api/v1/admin/legacy-sync/status`, {
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    expect(statusRes.status).toBe(200);
    const statusJson = (await statusRes.json()) as any;
    expect(statusJson.success).toBe(true);
    expect(statusJson.data.estadoActual).toBeDefined();
    expect(statusJson.data.scheduler.cronExpression).toBe('0 2 * * *');
    expect(statusJson.data.scheduler.timeZone).toBe('America/Mexico_City');
    expect(Array.isArray(statusJson.data.departamentosWeb)).toBe(true);
    expect(statusJson.data.departamentosWeb).toContain('PRELIMINARES');
    expect(Array.isArray(statusJson.data.departamentosLegacy)).toBe(true);
    expect(statusJson.data.departamentosLegacy).toContain('CORTE');

    // 7.5. GET /history con SUPER_ADMIN -> 200 OK y paginación
    const historyRes = await fetch(
      `${baseUrl}/api/v1/admin/legacy-sync/history?page=1&limit=10`,
      {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      }
    );
    expect(historyRes.status).toBe(200);
    const historyJson = (await historyRes.json()) as any;
    expect(historyJson.success).toBe(true);
    expect(historyJson.data.pagination.page).toBe(1);
    expect(Array.isArray(historyJson.data.items)).toBe(true);
    expect(historyJson.data.items.length).toBeGreaterThan(0);

    // 7.6. POST /run válido y rechazo 409 de ejecución simultánea duplicada
    const runRes1 = await fetch(`${baseUrl}/api/v1/admin/legacy-sync/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${superAdminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ archivo: 'Defectos_Bordado.txt' }),
    });
    expect(runRes1.status).toBe(202);
    const runJson1 = (await runRes1.json()) as any;
    expect(runJson1.success).toBe(true);
    expect(runJson1.data.cycleId).toBeDefined();
    expect(runJson1.data.archivosObjetivo).toEqual(['Defectos_Bordado.txt']);

    // Mientras la primera ejecución manual está activa, una segunda petición inmediata debe recibir 409 Conflict
    const runRes2 = await fetch(`${baseUrl}/api/v1/admin/legacy-sync/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${superAdminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ archivo: 'Defectos_Bordado.txt' }),
    });
    expect(runRes2.status).toBe(409);

    // Esperar a que termine limpiamente el ciclo en segundo plano dentro de la ventana de apagado ordenado
    const shutdownOutcome = await legacySyncSchedulerService.gracefulShutdown(10_000);
    expect(shutdownOutcome.completedCleanly).toBe(true);
    expect(shutdownOutcome.interrupted).toBe(false);

    // Registrar para limpieza el registro de control creado por POST /run
    const latestBordadoExec = await prisma.controlSincronizacionLegacy.findFirst({
      where: { archivo: 'Defectos_Bordado.txt' },
      orderBy: { id: 'desc' },
    });
    if (latestBordadoExec) {
      createdExecutionIds.push(latestBordadoExec.id);
    }
  });

  test('8. Apagado ordenado (gracefulShutdown): detiene cron, rechaza nuevas corridas y no libera bloqueos ajenos', async () => {
    const shutdownScheduler = new LegacySyncSchedulerService();
    shutdownScheduler.startScheduler();
    expect(shutdownScheduler.getStatus().schedulerActive).toBe(true);

    // Simulamos que OTRO proceso tiene el bloqueo global
    const otherProcessOwner = legacySyncLockService.generateOwnerUuid();
    await legacySyncLockService.acquireLock(GLOBAL_WORKER_LOCK_KEY, otherProcessOwner, 60_000);

    try {
      const result = await shutdownScheduler.gracefulShutdown(1000);
      expect(result.completedCleanly).toBe(true);
      expect(shutdownScheduler.getStatus().schedulerActive).toBe(false);
      expect(shutdownScheduler.getStatus().shuttingDown).toBe(true);

      // Verificar que NO liberó el bloqueo que pertenecía a otro proceso
      const lockAfterShutdown = await legacySyncLockService.getLockState(GLOBAL_WORKER_LOCK_KEY);
      expect(lockAfterShutdown?.propietarioUuid).toBe(otherProcessOwner);

      // Verificar que una vez en estado shuttingDown no acepta nuevas ejecuciones
      const postShutdownAttempt = await shutdownScheduler.runCycle('MANUAL_CLI');
      expect(postShutdownAttempt.skipped).toBe(true);
      expect(postShutdownAttempt.skipReason).toBe('SHUTTING_DOWN');
    } finally {
      await legacySyncLockService.releaseLock(GLOBAL_WORKER_LOCK_KEY, otherProcessOwner);
    }
  });
});

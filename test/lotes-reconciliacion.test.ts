import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { prisma } from '../src/config/database';
import {
  importarLotesDesdeCSV,
  extraerModelo,
  parseCSVLine,
  type ImportLotesResult,
} from '../src/modules/lotes/services/lotes-import.service';
import { lotesService, AmbiguousLoteError } from '../src/modules/lotes/services/lotes.service';
import {
  DEFAULT_LOTES_CRON_EXPRESSION,
  DEFAULT_LOTES_CRON_TIMEZONE,
  GLOBAL_LOTES_LOCK_KEY,
  LotesSyncSchedulerService,
} from '../src/modules/lotes/services/lotes-sync-scheduler.service';
import { legacySyncLockService } from '../src/modules/inspecciones/services/legacy-sync-lock.service';

const TEST_FIXTURES_DIR = path.resolve(process.cwd(), 'test', 'temp_fixtures');

describe('Suite Exhaustiva de Reconciliación del Catálogo de Lotes (MBC)', () => {
  let usuarioAdminId: number;
  let deptoId: number;

  beforeAll(async () => {
    if (!fs.existsSync(TEST_FIXTURES_DIR)) {
      fs.mkdirSync(TEST_FIXTURES_DIR, { recursive: true });
    }

    // Obtener o asegurar usuario admin
    const admin = await prisma.usuario.findFirst({
      where: { OR: [{ rol: { codigo: 'SUPER_ADMIN' } }, { usuario: 'admin' }] },
      select: { id: true },
    });
    usuarioAdminId = admin?.id || 1;

    // Obtener un departamento
    const depto = await prisma.departamento.findFirst({ select: { id: true } });
    deptoId = depto?.id || 1;
  });

  afterAll(async () => {
    // Limpieza de archivos temporales de prueba
    if (fs.existsSync(TEST_FIXTURES_DIR)) {
      fs.rmSync(TEST_FIXTURES_DIR, { recursive: true, force: true });
    }

    // Limpieza de bloqueos
    await prisma.bloqueoSincronizacionLegacy.deleteMany({
      where: { archivo: GLOBAL_LOTES_LOCK_KEY },
    });
  });

  // Requisitos 1, 2, 3: Inserción, Actualización y Omisión idempotente
  test('1, 2, 3. Inserción de lote nuevo, actualización ante cambios y omisión sin cambios (Idempotencia)', async () => {
    const csvPath = path.join(TEST_FIXTURES_DIR, 'test_lotes_123.csv');
    const lotePrueba = `TEST_${Date.now()}`;
    const listaPrueba = '99001';

    // 1.1 Inserción inicial
    const csvContent1 = [
      'Lista Lote,Lista,Lote,IdProducto,Cantidad,Descripcion,Cliente,Horma',
      `[L]${listaPrueba}${lotePrueba},${listaPrueba},${lotePrueba},103Z2LPH9052CUH,10,BOTA VAQUERA PITON,TIENDAS TEST,F68 EE`,
    ].join('\n');

    fs.writeFileSync(csvPath, csvContent1, 'utf-8');

    const resInsert = await importarLotesDesdeCSV({
      filePath: csvPath,
      usuarioId: usuarioAdminId,
      permitirInactivacion: false, // aislado para este test
    });

    expect(resInsert.insertados).toBe(1);
    expect(resInsert.actualizados).toBe(0);
    expect(resInsert.omitidos).toBe(0);
    expect(resInsert.rechazados).toBe(0);

    const loteEnBD = await prisma.produccionLote.findUnique({
      where: { unique_lista_lote: { lista: listaPrueba, lote: lotePrueba } },
    });
    expect(loteEnBD).not.toBeNull();
    expect(loteEnBD?.modelo).toBe('3Z2LPH');
    expect(Number(loteEnBD?.cantidad)).toBe(10);
    expect(loteEnBD?.estado).toBe('ACTIVO');

    // 1.2 Omisión: Misma entrada sin modificaciones
    const resOmit = await importarLotesDesdeCSV({
      filePath: csvPath,
      usuarioId: usuarioAdminId,
      permitirInactivacion: false,
    });

    expect(resOmit.insertados).toBe(0);
    expect(resOmit.actualizados).toBe(0);
    expect(resOmit.omitidos).toBe(1);

    // 1.3 Actualización: Cambio en cantidad y descripción
    const csvContentUpdate = [
      'Lista Lote,Lista,Lote,IdProducto,Cantidad,Descripcion,Cliente,Horma',
      `[L]${listaPrueba}${lotePrueba},${listaPrueba},${lotePrueba},103Z2LPH9052CUH,25,BOTA MODIFICADA,TIENDAS TEST,F68 EE`,
    ].join('\n');

    fs.writeFileSync(csvPath, csvContentUpdate, 'utf-8');

    const resUpdate = await importarLotesDesdeCSV({
      filePath: csvPath,
      usuarioId: usuarioAdminId,
      permitirInactivacion: false,
    });

    expect(resUpdate.insertados).toBe(0);
    expect(resUpdate.actualizados).toBe(1);
    expect(resUpdate.omitidos).toBe(0);

    const loteActualizado = await prisma.produccionLote.findUnique({
      where: { unique_lista_lote: { lista: listaPrueba, lote: lotePrueba } },
    });
    expect(Number(loteActualizado?.cantidad)).toBe(25);
    expect(loteActualizado?.descripcion).toBe('BOTA MODIFICADA');

    // Limpieza
    await prisma.produccionLote.deleteMany({
      where: { lote: lotePrueba },
    });
  });

  // Requisitos 4 y 5: Inactivación por ausencia en CSV y Reactivación si reaparece
  test('4, 5. Inactivación de lotes ausentes del CSV maestro y Reactivación fiel con ID preservado', async () => {
    const csvPath = path.join(TEST_FIXTURES_DIR, 'test_inactivacion.csv');
    const loteA = `TEST_ACT_${Date.now()}`;
    const loteB = `TEST_DES_${Date.now()}`;
    const lista = '99002';

    // Crear dos lotes activos
    const lote1 = await prisma.produccionLote.create({
      data: {
        listaLote: `[L]${lista}${loteA}`,
        lista,
        lote: loteA,
        idProducto: '103Z2LPH9052CUH',
        modelo: '3Z2LPH',
        cantidad: 15,
        cliente: 'CLIENTE A',
        estado: 'ACTIVO',
      },
    });

    const lote2 = await prisma.produccionLote.create({
      data: {
        listaLote: `[L]${lista}${loteB}`,
        lista,
        lote: loteB,
        idProducto: '103Z2LPH9052CUH',
        modelo: '3Z2LPH',
        cantidad: 20,
        cliente: 'CLIENTE B',
        estado: 'ACTIVO',
      },
    });

    // CSV que contiene a loteA y además otro lote nuevo, pero OMITE a loteB
    const csvContent = [
      'Lista Lote,Lista,Lote,IdProducto,Cantidad,Descripcion,Cliente,Horma',
      `[L]${lista}${loteA},${lista},${loteA},103Z2LPH9052CUH,15,DESC A,CLIENTE A,F68`,
    ].join('\n');

    fs.writeFileSync(csvPath, csvContent, 'utf-8');

    // Reconciliación con permitirInactivacion = true y scopeListas para aislamiento estricto
    const res = await importarLotesDesdeCSV({
      filePath: csvPath,
      usuarioId: usuarioAdminId,
      permitirInactivacion: true,
      scopeListas: [lista],
    });

    // Lote B debe haber sido inactivado
    const bDb = await prisma.produccionLote.findUnique({ where: { id: lote2.id } });
    expect(bDb?.estado).toBe('INACTIVO');

    // Ahora Lote B vuelve a aparecer en el CSV maestro -> Debe REACTIVARSE conservando su ID
    const csvReactivar = [
      'Lista Lote,Lista,Lote,IdProducto,Cantidad,Descripcion,Cliente,Horma',
      `[L]${lista}${loteA},${lista},${loteA},103Z2LPH9052CUH,15,DESC A,CLIENTE A,F68`,
      `[L]${lista}${loteB},${lista},${loteB},103Z2LPH9052CUH,20,DESC B REACTIVADO,CLIENTE B,F68`,
    ].join('\n');

    fs.writeFileSync(csvPath, csvReactivar, 'utf-8');

    const resReactivar = await importarLotesDesdeCSV({
      filePath: csvPath,
      usuarioId: usuarioAdminId,
      permitirInactivacion: true,
      scopeListas: [lista],
    });

    expect(resReactivar.reactivados).toBe(1);
    const bReactivado = await prisma.produccionLote.findUnique({ where: { id: lote2.id } });
    expect(bReactivado?.estado).toBe('ACTIVO');
    expect(bReactivado?.descripcion).toBe('DESC B REACTIVADO');
    expect(bReactivado?.id).toBe(lote2.id); // Conserva el ID primario

    // Limpieza
    await prisma.produccionLote.deleteMany({
      where: { lote: { in: [loteA, loteB] } },
    });
  });

  // Requisitos 6 y 7: Dos lotes con el mismo número y diferente lista sin fallback destructivo
  test('6, 7. Dos registros con el mismo número de lote en listas diferentes se conservan independientemente sin colisión ni sobreescritura de modelo', async () => {
    const csvPath = path.join(TEST_FIXTURES_DIR, 'test_homonimos.csv');
    const loteNumero = `HOMONIMO_${Date.now()}`;
    const lista1 = '26220';
    const lista2 = '26L61';

    // Modelo para lista1: 3Z2LPH (103Z2LPH...)
    // Modelo para lista2: 4W24RS (104W24RS...)
    const csvContent = [
      'Lista Lote,Lista,Lote,IdProducto,Cantidad,Descripcion,Cliente,Horma',
      `[L]${lista1}${loteNumero},${lista1},${loteNumero},103Z2LPH9052CUH,10,MODELO BOTIN,TIENDAS CUADRA,F68 EE`,
      `[L]${lista2}${loteNumero},${lista2},${loteNumero},104W24RS0002CUD,12,MODELO MOCASIN,ZAPATERIAS SUPER,F44 EE`,
    ].join('\n');

    fs.writeFileSync(csvPath, csvContent, 'utf-8');

    const res = await importarLotesDesdeCSV({
      filePath: csvPath,
      usuarioId: usuarioAdminId,
      permitirInactivacion: false,
    });

    expect(res.insertados).toBe(2);
    expect(res.rechazados).toBe(0);

    // Comprobar que en la base de datos existen ambos registros independientes
    const lotesEnBD = await prisma.produccionLote.findMany({
      where: { lote: loteNumero },
      orderBy: { lista: 'asc' },
    });

    expect(lotesEnBD.length).toBe(2);

    const reg1 = lotesEnBD.find((l) => l.lista === lista1);
    const reg2 = lotesEnBD.find((l) => l.lista === lista2);

    expect(reg1).not.toBeNull();
    expect(reg2).not.toBeNull();
    expect(reg1?.modelo).toBe('3Z2LPH');
    expect(reg2?.modelo).toBe('4W24RS');
    expect(reg1?.id).not.toBe(reg2?.id); // IDs primarios distintos

    // Test de consulta con desambiguación en lotesService
    // Consulta con lista explícita
    const l1 = await lotesService.getByCodigoLote(loteNumero, lista1);
    expect(l1.lista).toBe(lista1);
    expect(l1.modelo).toBe('3Z2LPH');

    const l2 = await lotesService.getByCodigoLote(loteNumero, lista2);
    expect(l2.lista).toBe(lista2);
    expect(l2.modelo).toBe('4W24RS');

    // Consulta por código canónico [L]listaLote directo
    const lCan = await lotesService.getByCodigoLote(`[L]${lista1}${loteNumero}`);
    expect(lCan.lista).toBe(lista1);
    expect(lCan.modelo).toBe('3Z2LPH');

    // Consulta sin lista cuando hay homónimos -> Debe lanzar AmbiguousLoteError
    expect(async () => {
      await lotesService.getByCodigoLote(loteNumero);
    }).toThrow(AmbiguousLoteError);

    // Limpieza
    await prisma.produccionLote.deleteMany({
      where: { lote: loteNumero },
    });
  });

  // Requisito 8: Conservación de relaciones históricas de inspecciones
  test('8. Conservación intacta de inspecciones históricas enlazadas a produccion_lotes', async () => {
    const loteCod = `TEST_INSP_${Date.now()}`;
    const lista = '99003';

    // 1. Crear lote
    const lote = await prisma.produccionLote.create({
      data: {
        listaLote: `[L]${lista}${loteCod}`,
        lista,
        lote: loteCod,
        idProducto: '103Z2LPH9052CUH',
        modelo: '3Z2LPH',
        cantidad: 30,
        cliente: 'CLIENTE HISTORICO',
        estado: 'ACTIVO',
      },
    });

    // 2. Crear una inspección vinculada
    const insp = await prisma.inspeccionCabecera.create({
      data: {
        folio: `INS-TEST-${Date.now()}`,
        loteId: lote.id,
        inspectorId: usuarioAdminId,
        departamentoAuditoriaId: deptoId,
        estado: 'APROBADO',
        claveIdempotencia: `idem-${Date.now()}`,
      },
    });

    // 3. Modificar datos del lote vía reconciliación
    const csvPath = path.join(TEST_FIXTURES_DIR, 'test_insp_reconcil.csv');
    const csvContent = [
      'Lista Lote,Lista,Lote,IdProducto,Cantidad,Descripcion,Cliente,Horma',
      `[L]${lista}${loteCod},${lista},${loteCod},103Z2LPH9052CUH,30,NUEVA DESCRIPCION AUDITADA,CLIENTE HISTORICO,F68`,
    ].join('\n');

    fs.writeFileSync(csvPath, csvContent, 'utf-8');

    await importarLotesDesdeCSV({
      filePath: csvPath,
      usuarioId: usuarioAdminId,
      permitirInactivacion: false,
    });

    // 4. Verificar que la inspección histórica conserva exactamente la relación con lote.id
    const inspPost = await prisma.inspeccionCabecera.findUnique({
      where: { id: insp.id },
      include: { lote: true },
    });

    expect(inspPost).not.toBeNull();
    expect(inspPost?.loteId).toBe(lote.id);
    expect(inspPost?.lote.descripcion).toBe('NUEVA DESCRIPCION AUDITADA');

    // Limpieza
    await prisma.inspeccionCabecera.delete({ where: { id: insp.id } });
    await prisma.produccionLote.delete({ where: { id: lote.id } });
  });

  // Requisito 9: Rechazo de archivos mal formados o incompletos estructuralmente (Fail-Fast)
  test('9. Rechazo y aborto de reconciliación ante archivos vacíos, cabeceras inválidas o filas mal formadas', async () => {
    // 9.1 Archivo vacío
    const csvVacio = path.join(TEST_FIXTURES_DIR, 'test_vacio.csv');
    fs.writeFileSync(csvVacio, '', 'utf-8');

    expect(async () => {
      await importarLotesDesdeCSV({ filePath: csvVacio });
    }).toThrow('vacío');

    // 9.2 Cabecera inválida
    const csvCabeceraInvalida = path.join(TEST_FIXTURES_DIR, 'test_cabecera.csv');
    fs.writeFileSync(csvCabeceraInvalida, 'Col1,Col2,Col3\n1,2,3', 'utf-8');

    expect(async () => {
      await importarLotesDesdeCSV({ filePath: csvCabeceraInvalida });
    }).toThrow('no coincide con las 8 columnas esperadas');

    // 9.3 Filas mal formadas (columna faltante o idProducto inválido) -> Fail-Fast
    const csvFilaInvalida = path.join(TEST_FIXTURES_DIR, 'test_fila_err.csv');
    fs.writeFileSync(
      csvFilaInvalida,
      [
        'Lista Lote,Lista,Lote,IdProducto,Cantidad,Descripcion,Cliente,Horma',
        '[L]1120151355,11201,51355,ID_INVALIDO_SIN_10,1,,MUESTRAS,',
      ].join('\n'),
      'utf-8'
    );

    expect(async () => {
      await importarLotesDesdeCSV({ filePath: csvFilaInvalida });
    }).toThrow('errores estructurales');
  });

  // Requisito 10: Bloqueo distribuido y reintentos ante colisión
  test('10. Bloqueo distribuido atómico (__WORKER_LOTES_SYNC__) y motor de reintentos', async () => {
    const scheduler = new LotesSyncSchedulerService();
    const fakeOwner = legacySyncLockService.generateOwnerUuid();

    const acquired = await legacySyncLockService.acquireLock(GLOBAL_LOTES_LOCK_KEY, fakeOwner, 60_000);
    expect(acquired).toBe(true);

    try {
      const ticket = await scheduler.startAsyncManualRun();
      expect(ticket.accepted).toBe(false);
      expect(ticket.skipReason).toBe('GLOBAL_LOCK_HELD');
    } finally {
      await legacySyncLockService.releaseLock(GLOBAL_LOTES_LOCK_KEY, fakeOwner);
    }
  });

  // Requisito 11: Modo Previsualización (dryRun)
  test('11. Modo de previsualización (dryRun) calcula métricas exactas sin aplicar escrituras en base de datos', async () => {
    const csvPath = path.join(TEST_FIXTURES_DIR, 'test_dry_run.csv');
    const loteNuevo = `TEST_DRY_${Date.now()}`;
    const lista = '99004';

    const csvContent = [
      'Lista Lote,Lista,Lote,IdProducto,Cantidad,Descripcion,Cliente,Horma',
      `[L]${lista}${loteNuevo},${lista},${loteNuevo},103Z2LPH9052CUH,10,BOTA DRY RUN,CLIENTE PREVIEW,F68`,
    ].join('\n');

    fs.writeFileSync(csvPath, csvContent, 'utf-8');

    const resPreview = await importarLotesDesdeCSV({
      filePath: csvPath,
      usuarioId: usuarioAdminId,
      dryRun: true,
      permitirInactivacion: false,
    });

    expect(resPreview.dryRun).toBe(true);
    expect(resPreview.insertados).toBe(1);
    expect(resPreview.inactivacionEjecutada).toBe(false);

    // Verificar que en MySQL NO se insertó nada
    const enBd = await prisma.produccionLote.findUnique({
      where: { unique_lista_lote: { lista, lote: loteNuevo } },
    });
    expect(enBd).toBeNull();
  });

  // Requisito 12: Horarios automáticos y cálculo de corte
  test('12. Horarios automáticos (06:00 AM America/Mexico_City) y expresión cron válida', () => {
    const scheduler = new LotesSyncSchedulerService();
    expect(scheduler.validateExpression(DEFAULT_LOTES_CRON_EXPRESSION)).toBe(true);
    expect(DEFAULT_LOTES_CRON_EXPRESSION).toBe('0 6 * * *');
    expect(DEFAULT_LOTES_CRON_TIMEZONE).toBe('America/Mexico_City');

    const status = scheduler.getStatus();
    expect(status.cronExpression).toBe('0 6 * * *');
    expect(status.timeZone).toBe('America/Mexico_City');
  });
});

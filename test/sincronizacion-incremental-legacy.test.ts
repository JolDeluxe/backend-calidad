import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { prisma } from '../src/config/database';
import { legacySyncLockService } from '../src/modules/inspecciones/services/legacy-sync-lock.service';
import { legacyIncrementalSyncService } from '../src/modules/inspecciones/services/legacy-incremental-sync.service';

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

describe('Suite Integral FASE 3.6 y FASE 4 — Sincronización Incremental Legacy -> Web MBC', () => {
  let tempDir: string;
  const testNos = ['998001', '998002', '998003', '998004', '998005'];
  const testLoteCode = '998877';
  let webCabeceraTestId: number | null = null;
  let initialTotalCabeceras = 0;
  let initialWebCabeceras = 0;

  async function cleanupTestArtifacts() {
    // Limpiar únicamente los artefactos de prueba con noOriginal en testNos o lote 998877
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
  }

  beforeAll(async () => {
    await cleanupTestArtifacts();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc_sync_test_'));
    initialTotalCabeceras = await prisma.inspeccionCabecera.count();
    initialWebCabeceras = await prisma.inspeccionCabecera.count({
      where: { procedencia: 'WEB' },
    });
  });

  afterAll(async () => {
    await cleanupTestArtifacts();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('1. Bloqueo atómico por archivo: adquisición exclusiva, renovación por propietario y liberación segura', async () => {
    const testFile = 'Defectos_Test_Lock.txt';
    const ownerA = legacySyncLockService.generateOwnerUuid();
    const ownerB = legacySyncLockService.generateOwnerUuid();

    // Owner A adquiere el bloqueo
    const acquiredA = await legacySyncLockService.acquireLock(testFile, ownerA, 60_000);
    expect(acquiredA).toBe(true);

    // Owner B intenta adquirir simultáneamente -> debe ser rechazado
    const acquiredB = await legacySyncLockService.acquireLock(testFile, ownerB, 60_000);
    expect(acquiredB).toBe(false);

    // Owner B intenta renovar o liberar el bloqueo de Owner A -> debe ser rechazado
    const renewB = await legacySyncLockService.renewLock(testFile, ownerB, 60_000);
    expect(renewB).toBe(false);
    const releaseB = await legacySyncLockService.releaseLock(testFile, ownerB);
    expect(releaseB).toBe(false);

    // Owner A renueva y libera su propio bloqueo -> exitoso
    const renewA = await legacySyncLockService.renewLock(testFile, ownerA, 90_000);
    expect(renewA).toBe(true);
    const releaseA = await legacySyncLockService.releaseLock(testFile, ownerA);
    expect(releaseA).toBe(true);

    // Ahora Owner B sí puede adquirirlo
    const acquiredBAfter = await legacySyncLockService.acquireLock(testFile, ownerB, 60_000);
    expect(acquiredBAfter).toBe(true);
    await legacySyncLockService.releaseLock(testFile, ownerB);

    await prisma.bloqueoSincronizacionLegacy.deleteMany({ where: { archivo: testFile } });
  });

  test('2. Importación inicial inserta registros separando sesiones L1 y L2 y respetando reinicio anual de No en CORTE', async () => {
    // Crear archivo Defectos_corte.txt en carpeta temporal con:
    // - No=998001 en 2025 (L1)
    // - No=998001 en 2026 (L2) -> mismo No en distinto año y distinta línea
    const corteRows = [
      HEADER_14,
      [
        '998001',
        'CORTE',
        ' 15 / 11 / 2025 ',
        '25200',
        testLoteCode,
        'L1',
        '4Q18RS',
        'BOTA DE RES TEST',
        'CORTE',
        '1113',
        'Piel con falla zona A',
        '2',
        '112 M',
        'JACQUELINE MEZA',
      ].join('\t'),
      [
        '998001',
        'CORTE',
        ' 15 / 01 / 2026 ',
        '26010',
        testLoteCode,
        'L2',
        '4Q18RS',
        'BOTA DE RES TEST',
        'CORTE',
        '1113',
        'Piel con falla zona A',
        '3',
        '112 M',
        'JACQUELINE MEZA',
      ].join('\t'),
      [
        '998002',
        'CORTE',
        ' 15 / 01 / 2026 ',
        '26010',
        testLoteCode,
        'L1',
        '4Q18RS',
        'BOTA DE RES TEST',
        'CORTE',
        '1118',
        'Piezas mal cortadas',
        '1',
        '112 M',
        'JACQUELINE MEZA',
      ].join('\t'),
    ].join('\r\n');

    fs.writeFileSync(path.join(tempDir, 'Defectos_corte.txt'), corteRows, 'latin1');

    const res = await legacyIncrementalSyncService.syncAll({
      baseDir: tempDir,
      archivosFiltro: ['Defectos_corte.txt'],
      departamentosWeb: ['PRELIMINARES'],
      stabilityDelayMs: 5,
    });

    expect(res).toHaveLength(1);
    expect(res[0].estado).toBe('EXITOSO');
    expect(res[0].registrosDetectados).toBe(3);
    expect(res[0].registrosInsertados).toBe(3);
    expect(res[0].registrosOmitidos).toBe(0);

    // Verificar que las dos filas de 2026-01-15 con L1 y L2 crearon 2 cabeceras separadas (no fusionadas)
    const loteDB = await prisma.produccionLote.findUnique({ where: { lote: testLoteCode } });
    expect(loteDB).not.toBeNull();

    const cabecerasLote = await prisma.inspeccionCabecera.findMany({
      where: { loteId: loteDB!.id },
      include: { detalles: true },
      orderBy: { id: 'asc' },
    });

    // 1 cabecera de 2025 (L1), 1 cabecera de 2026 (L2), 1 cabecera de 2026 (L1) = 3 cabeceras
    expect(cabecerasLote).toHaveLength(3);
    expect(cabecerasLote.every(c => c.procedencia === 'LEGACY')).toBe(true);
  });

  test('3. Segunda ejecución (idempotencia) no duplica registros', async () => {
    const res = await legacyIncrementalSyncService.syncAll({
      baseDir: tempDir,
      archivosFiltro: ['Defectos_corte.txt'],
      departamentosWeb: ['PRELIMINARES'],
      stabilityDelayMs: 5,
    });

    expect(res[0].estado).toBe('EXITOSO');
    expect(res[0].registrosDetectados).toBe(3);
    expect(res[0].registrosInsertados).toBe(0);
    expect(res[0].registrosActualizados).toBe(0);
    expect(res[0].registrosOmitidos).toBe(3);
  });

  test('4. Los registros WEB permanecen 100% intactos durante la sincronización', async () => {
    const loteDB = await prisma.produccionLote.findUniqueOrThrow({ where: { lote: testLoteCode } });
    const prelimDepto = await prisma.departamento.findFirstOrThrow({
      where: { codigo: 'PRELIMINARES' },
    });
    const adminUser = await prisma.usuario.findFirstOrThrow();
    const defPrelim = await prisma.defecto.findFirstOrThrow({
      where: { departamentoId: prelimDepto.id },
    });

    const createdWeb = await prisma.inspeccionCabecera.create({
      data: {
        folio: `INS-20261106-9999`,
        loteId: loteDB.id,
        inspectorId: adminUser.id,
        departamentoAuditoriaId: prelimDepto.id,
        lineaTexto: 'L1',
        estado: 'APROBADO',
        procedencia: 'WEB',
        notas: 'Captura WEB en Preliminares',
        detalles: {
          create: [
            {
              defectoId: defPrelim.id,
              defDeptoId: prelimDepto.id,
              paresDefectuosos: 4,
              notas: 'Defecto capturado en WEB',
            },
          ],
        },
      },
      include: { detalles: true },
    });
    webCabeceraTestId = createdWeb.id;

    // Incluso si existiera un archivo Defectos_Preliminares.txt con datos distintos, PRELIMINARES está en WEB
    fs.writeFileSync(
      path.join(tempDir, 'Defectos_Preliminares.txt'),
      [
        HEADER_14,
        [
          '998003',
          'PRELIMINARES',
          ' 06 / 11 / 2026 ',
          '26010',
          testLoteCode,
          'L1',
          '4Q18RS',
          'BOTA TEST',
          'PRELIMINARES',
          String(defPrelim.clave),
          'Defecto',
          '99',
          '112 M',
          'INSPECTOR',
        ].join('\t'),
      ].join('\r\n'),
      'latin1'
    );

    const res = await legacyIncrementalSyncService.syncAll({
      baseDir: tempDir,
      archivosFiltro: ['Defectos_Preliminares.txt', 'Defectos_corte.txt'],
      departamentosWeb: ['PRELIMINARES'],
      stabilityDelayMs: 5,
    });

    const prelimRes = res.find(r => r.archivo === 'Defectos_Preliminares.txt')!;
    expect(prelimRes.estado).toBe('OMITIDO_WEB');
    expect(prelimRes.omitidoPorModoWeb).toBe(true);
    expect(prelimRes.registrosInsertados).toBe(0);

    // Verificar que la captura WEB permanece intacta
    const verifyWeb = await prisma.inspeccionCabecera.findUniqueOrThrow({
      where: { id: webCabeceraTestId },
      include: { detalles: true },
    });
    expect(verifyWeb.procedencia).toBe('WEB');
    expect(verifyWeb.notas).toBe('Captura WEB en Preliminares');
    expect(verifyWeb.detalles).toHaveLength(1);
    expect(verifyWeb.detalles[0].paresDefectuosos).toBe(4);
  });

  test('5. Modificación de registro LEGACY actualiza el detalle y guarda auditoría en HistoricoModificacionLegacy', async () => {
    // Cambiar pares de No=998002 en 2026 de 1 par a 7 pares
    const updatedCorteRows = [
      HEADER_14,
      [
        '998001',
        'CORTE',
        ' 15 / 11 / 2025 ',
        '25200',
        testLoteCode,
        'L1',
        '4Q18RS',
        'BOTA DE RES TEST',
        'CORTE',
        '1113',
        'Piel con falla zona A',
        '2',
        '112 M',
        'JACQUELINE MEZA',
      ].join('\t'),
      [
        '998001',
        'CORTE',
        ' 15 / 01 / 2026 ',
        '26010',
        testLoteCode,
        'L2',
        '4Q18RS',
        'BOTA DE RES TEST',
        'CORTE',
        '1113',
        'Piel con falla zona A',
        '3',
        '112 M',
        'JACQUELINE MEZA',
      ].join('\t'),
      [
        '998002',
        'CORTE',
        ' 15 / 01 / 2026 ',
        '26010',
        testLoteCode,
        'L1',
        '4Q18RS',
        'BOTA DE RES TEST',
        'CORTE',
        '1118',
        'Piezas mal cortadas',
        '7', // Antes era 1
        '112 M',
        'JACQUELINE MEZA',
      ].join('\t'),
    ].join('\r\n');

    fs.writeFileSync(path.join(tempDir, 'Defectos_corte.txt'), updatedCorteRows, 'latin1');

    const res = await legacyIncrementalSyncService.syncAll({
      baseDir: tempDir,
      archivosFiltro: ['Defectos_corte.txt'],
      departamentosWeb: ['PRELIMINARES'],
      stabilityDelayMs: 5,
    });

    expect(res[0].estado).toBe('EXITOSO');
    expect(res[0].registrosInsertados).toBe(0);
    expect(res[0].registrosActualizados).toBe(1);
    expect(res[0].registrosOmitidos).toBe(2);

    const origenMod = await prisma.inspeccionHistoricaOrigen.findFirstOrThrow({
      where: { archivoOrigen: 'Defectos_corte.txt', anioOrigen: 2026, noOriginal: '998002' },
      include: { detalle: true, modificaciones: true },
    });

    expect(origenMod.pares).toBe(7);
    expect(origenMod.detalle?.paresDefectuosos).toBe(7);
    expect(origenMod.modificaciones).toHaveLength(1);
    expect((origenMod.modificaciones[0].valoresAnteriores as any).pares).toBe(1);
    expect((origenMod.modificaciones[0].valoresNuevos as any).pares).toBe(7);
    expect(origenMod.modificaciones[0].sincronizacionId).toBe(res[0].sincronizacionId!);
  });

  test('6. Protección de borrados lógicos: un registro eliminado lógicamente nunca se reactiva ni modifica', async () => {
    const origenMod = await prisma.inspeccionHistoricaOrigen.findFirstOrThrow({
      where: { archivoOrigen: 'Defectos_corte.txt', anioOrigen: 2026, noOriginal: '998002' },
      include: { detalle: true },
    });

    const deletedAt = new Date();
    await prisma.inspeccionDetalle.update({
      where: { id: origenMod.detalle!.id },
      data: {
        eliminadoEn: deletedAt,
        eliminadoMotivo: 'Eliminado lógicamente por supervisor',
      },
    });

    // Ahora cambiamos pares en el TXT de 7 a 12 para No=998002
    const rowsChangeDeleted = [
      HEADER_14,
      [
        '998001',
        'CORTE',
        ' 15 / 11 / 2025 ',
        '25200',
        testLoteCode,
        'L1',
        '4Q18RS',
        'BOTA DE RES TEST',
        'CORTE',
        '1113',
        'Piel con falla zona A',
        '2',
        '112 M',
        'JACQUELINE MEZA',
      ].join('\t'),
      [
        '998001',
        'CORTE',
        ' 15 / 01 / 2026 ',
        '26010',
        testLoteCode,
        'L2',
        '4Q18RS',
        'BOTA DE RES TEST',
        'CORTE',
        '1113',
        'Piel con falla zona A',
        '3',
        '112 M',
        'JACQUELINE MEZA',
      ].join('\t'),
      [
        '998002',
        'CORTE',
        ' 15 / 01 / 2026 ',
        '26010',
        testLoteCode,
        'L1',
        '4Q18RS',
        'BOTA DE RES TEST',
        'CORTE',
        '1118',
        'Piezas mal cortadas',
        '12', // Intento de cambio sobre un registro eliminado lógicamente
        '112 M',
        'JACQUELINE MEZA',
      ].join('\t'),
    ].join('\r\n');

    fs.writeFileSync(path.join(tempDir, 'Defectos_corte.txt'), rowsChangeDeleted, 'latin1');

    const res = await legacyIncrementalSyncService.syncAll({
      baseDir: tempDir,
      archivosFiltro: ['Defectos_corte.txt'],
      departamentosWeb: ['PRELIMINARES'],
      stabilityDelayMs: 5,
    });

    expect(res[0].estado).toBe('EXITOSO');
    expect(res[0].registrosActualizados).toBe(0);
    expect(res[0].registrosOmitidos).toBe(3);

    const verifyDetalle = await prisma.inspeccionDetalle.findUniqueOrThrow({
      where: { id: origenMod.detalle!.id },
    });
    expect(verifyDetalle.eliminadoEn).not.toBeNull();
    expect(verifyDetalle.paresDefectuosos).toBe(7); // No fue sobrescrito con 12
  });

  test('7. Migrar CORTE a WEB detiene exclusivamente su importación mientras AVÍOS (con desplazamiento de columna) sigue sincronizándose', async () => {
    // Crear archivo Defectos_Avios.txt con 13 columnas de datos (sin columna Linea)
    // Y agregar una fila nueva a Defectos_corte.txt (No=998004) que NO debe importarse porque CORTE pasa a WEB
    const aviosContent = [
      HEADER_14,
      [
        '998005',
        'AVIOS',
        ' 06 / 11 / 2026 ',
        '26010',
        testLoteCode,
        '4Q18RS', // parts[5] = Modelo (sin Linea)
        'HEBILLA METALICA', // parts[6] = Descripcion
        'AVIOS', // parts[7] = DefDepto
        '1602', // parts[8] = Id Defecto
        'Hebilla rayada', // parts[9] = Defecto
        '5', // parts[10] = Prs
        '112 M', // parts[11] = Horma
        'ERIKA JACQUELIN ORTEGA', // parts[12] = Usuario
        '',
      ].join('\t'),
    ].join('\r\n');

    fs.writeFileSync(path.join(tempDir, 'Defectos_Avios.txt'), aviosContent, 'latin1');

    const res = await legacyIncrementalSyncService.syncAll({
      baseDir: tempDir,
      archivosFiltro: ['Defectos_Preliminares.txt', 'Defectos_corte.txt', 'Defectos_Avios.txt'],
      departamentosWeb: ['PRELIMINARES', 'CORTE'],
      stabilityDelayMs: 5,
    });

    const resPrelim = res.find(r => r.archivo === 'Defectos_Preliminares.txt')!;
    const resCorte = res.find(r => r.archivo === 'Defectos_corte.txt')!;
    const resAvios = res.find(r => r.archivo === 'Defectos_Avios.txt')!;

    expect(resPrelim.estado).toBe('OMITIDO_WEB');
    expect(resCorte.estado).toBe('OMITIDO_WEB');
    expect(resAvios.estado).toBe('EXITOSO');
    expect(resAvios.registrosInsertados).toBe(1);

    const aviosOrigen = await prisma.inspeccionHistoricaOrigen.findFirstOrThrow({
      where: { archivoOrigen: 'Defectos_Avios.txt', noOriginal: '998005' },
      include: { detalle: { include: { inspeccion: true } } },
    });
    expect(aviosOrigen.modelo).toBe('4Q18RS');
    expect(aviosOrigen.pares).toBe(5);
    expect(aviosOrigen.detalle?.paresDefectuosos).toBe(5);
  });

  test('8. Tolerancia a fallos: TXT corrupto, archivo inestable en escritura e interrupción a mitad de transacción hacen rollback y marcan FALLIDO', async () => {
    // 8.1. Simular archivo inestable en escritura (cambia hash durante lectura)
    const resInstability = await legacyIncrementalSyncService.syncAll({
      baseDir: tempDir,
      archivosFiltro: ['Defectos_Avios.txt'],
      departamentosWeb: ['PRELIMINARES'],
      stabilityDelayMs: 5,
      simulateInstabilityOnFile: 'Defectos_Avios.txt',
    });
    expect(resInstability[0].estado).toBe('FALLIDO');
    expect(resInstability[0].mensajeError).toContain('ARCHIVO_INESTABLE_EN_ESCRITURA');

    // 8.2. Simular interrupción a mitad de la transacción con una fila nueva (No=998004)
    const aviosWithNewRow = [
      HEADER_14,
      [
        '998004',
        'AVIOS',
        ' 06 / 11 / 2026 ',
        '26010',
        testLoteCode,
        '4Q18RS',
        'HEBILLA METALICA',
        'AVIOS',
        '1602',
        'Hebilla rayada',
        '9',
        '112 M',
        'ERIKA JACQUELIN ORTEGA',
        '',
      ].join('\t'),
    ].join('\r\n');
    fs.writeFileSync(path.join(tempDir, 'Defectos_Avios.txt'), aviosWithNewRow, 'latin1');

    const resInterrupted = await legacyIncrementalSyncService.syncAll({
      baseDir: tempDir,
      archivosFiltro: ['Defectos_Avios.txt'],
      departamentosWeb: ['PRELIMINARES'],
      stabilityDelayMs: 5,
      simulateInterruptionOnFile: 'Defectos_Avios.txt',
    });

    expect(resInterrupted[0].estado).toBe('FALLIDO');
    expect(resInterrupted[0].mensajeError).toContain('INTERRUPCION_SIMULADA');

    // Verificar que el rollback revirtió por completo la inserción de No=998004
    const rolledBackRow = await prisma.inspeccionHistoricaOrigen.findFirst({
      where: { archivoOrigen: 'Defectos_Avios.txt', noOriginal: '998004' },
    });
    expect(rolledBackRow).toBeNull();

    // Y que el registro de auditoría en ControlSincronizacionLegacy quedó marcado como FALLIDO
    const auditRecord = await prisma.controlSincronizacionLegacy.findUniqueOrThrow({
      where: { id: resInterrupted[0].sincronizacionId! },
    });
    expect(auditRecord.estado).toBe('FALLIDO');

    // 8.3. Archivo con encabezado corrupto
    fs.writeFileSync(path.join(tempDir, 'Defectos_Bordado.txt'), 'CORRUPT_HEADER_WITHOUT_TABS', 'latin1');
    const resCorrupt = await legacyIncrementalSyncService.syncAll({
      baseDir: tempDir,
      archivosFiltro: ['Defectos_Bordado.txt'],
      departamentosWeb: ['PRELIMINARES'],
      stabilityDelayMs: 5,
    });
    expect(resCorrupt[0].estado).toBe('FALLIDO');
    expect(resCorrupt[0].mensajeError).toContain('ESTRUCTURA_INVALIDA');
  });

  test('9. Rechazo de registros inválidos (sin lote, lotes sintéticos LOTE-..., defectos inexistentes o ADORNO infiltrado)', async () => {
    const mixedContent = [
      HEADER_14,
      // Fila 1: Lote vacío -> rechazada
      ['998010', 'MONTADO', ' 06 / 11 / 2026 ', '26010', '', 'L1', '4Q18RS', 'DESC', 'MONTADO', '1508', 'Def', '1', '112 M', 'USER'].join('\t'),
      // Fila 2: Lote sintético LOTE-4Q18RS -> rechazada
      ['998011', 'MONTADO', ' 06 / 11 / 2026 ', '26010', 'LOTE-4Q18RS', 'L1', '4Q18RS', 'DESC', 'MONTADO', '1508', 'Def', '1', '112 M', 'USER'].join('\t'),
      // Fila 3: Clave de defecto inexistente 88888 -> rechazada
      ['998012', 'MONTADO', ' 06 / 11 / 2026 ', '26010', testLoteCode, 'L1', '4Q18RS', 'DESC', 'MONTADO', '88888', 'Def', '1', '112 M', 'USER'].join('\t'),
      // Fila 4: Departamento ADORNO infiltrado -> rechazada
      ['998013', 'ADORNO', ' 06 / 11 / 2026 ', '26010', testLoteCode, 'L1', '4Q18RS', 'DESC', 'ADORNO', '1801', 'Def', '1', '112 M', 'USER'].join('\t'),
    ].join('\r\n');

    fs.writeFileSync(path.join(tempDir, 'Defectos_Montado.txt'), mixedContent, 'latin1');

    const res = await legacyIncrementalSyncService.syncAll({
      baseDir: tempDir,
      archivosFiltro: ['Defectos_Montado.txt'],
      departamentosWeb: ['PRELIMINARES'],
      stabilityDelayMs: 5,
    });

    expect(res[0].estado).toBe('EXITOSO');
    expect(res[0].registrosDetectados).toBe(4);
    expect(res[0].registrosInsertados).toBe(0);
    expect(res[0].registrosRechazados).toBe(4);
    expect(res[0].rechazos.map(r => r.motivo)).toEqual([
      'LOTE_VACIO_O_SINTETICO',
      'LOTE_VACIO_O_SINTETICO',
      'DEFECTO_NO_EXISTE_EN_CATALOGO:88888',
      'DEPARTAMENTO_ADORNO_SEGREGADO',
    ]);
  });

  test('10. Los conteos previos de la base de datos de desarrollo permanecen intactos tras limpiar los artefactos de prueba', async () => {
    await cleanupTestArtifacts();
    const finalTotalCabeceras = await prisma.inspeccionCabecera.count();
    const finalWebCabeceras = await prisma.inspeccionCabecera.count({
      where: { procedencia: 'WEB' },
    });

    expect(finalTotalCabeceras).toBe(initialTotalCabeceras);
    expect(finalWebCabeceras).toBe(initialWebCabeceras);
  });
});

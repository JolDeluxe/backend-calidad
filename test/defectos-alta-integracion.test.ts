import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../src/config/database";
import { defectosService } from "../src/modules/defectos/services/defectos.service";
import { codificacionDefectosService } from "../src/modules/defectos/services/codificacion-defectos.service";

describe("Integración: Alta de Defectos y Codificación por Departamento", () => {
  let adminUserId = 1;
  const idsCreados: number[] = [];

  beforeAll(async () => {
    const admin = await prisma.usuario.findFirst({
      where: { rol: { codigo: "SUPER_ADMIN" } },
      select: { id: true },
    });
    if (admin) adminUserId = admin.id;
  });

  afterAll(async () => {
    if (idsCreados.length > 0) {
      await prisma.defectoEtapa.deleteMany({ where: { defectoId: { in: idsCreados } } });
      await prisma.defectoDepartamento.deleteMany({ where: { defectoId: { in: idsCreados } } });
      await prisma.defecto.deleteMany({ where: { id: { in: idsCreados } } });
    }
  });

  // Departamentos BOTA: CORTE (1), PRELIMINARES (2), BORDADO Y LASER (3), PESPUNTE (4), MONTADO (5), ACABADO (6), AVIOS (7), ADORNO (11)
  const deptosBota = [
    { codigo: "CORTE", prefijoEsperado: 11 },
    { codigo: "PRELIMINARES", prefijoEsperado: 12 },
    { codigo: "BORDADO_Y_LASER", prefijoEsperado: 13 },
    { codigo: "PESPUNTE", prefijoEsperado: 14 },
    { codigo: "MONTADO", prefijoEsperado: 15 },
    { codigo: "ACABADO", prefijoEsperado: 17 },
    { codigo: "AVIOS", prefijoEsperado: 16 },
    { codigo: "ADORNO", prefijoEsperado: 18 },
  ];

  for (const { codigo, prefijoEsperado } of deptosBota) {
    it(`Crea correctamente un defecto para ${codigo} con prefijo ${prefijoEsperado}xx y matriz de etapas`, async () => {
      const depto = await prisma.departamento.findUnique({ where: { codigo } });
      expect(depto).toBeDefined();
      if (!depto) return;

      const nuevo = await defectosService.createDefecto(
        {
          defecto: `Defecto de prueba automatizada ${codigo} ${Date.now()}`,
          clasificacion: "MENOR",
          departamentoId: depto.id,
          lineaId: 1, // BOTA
          departamentosIds: [depto.id],
        },
        adminUserId
      );

      expect(nuevo).toBeDefined();
      expect(nuevo.id).toBeGreaterThan(0);
      idsCreados.push(nuevo.id);

      // 1. Clave dentro del prefijo
      const prefijoReal = Math.floor(nuevo.clave / 100);
      expect(prefijoReal).toBe(prefijoEsperado);

      // 2. Departamento propietario es exactamente el seleccionado
      expect(nuevo.departamentoId).toBe(depto.id);

      // 3. Matriz de etapas registrada
      const etapas = await prisma.defectoEtapa.findMany({
        where: { defectoId: nuevo.id },
      });
      expect(etapas.length).toBeGreaterThan(0);
      // El propio departamento debe estar permitido
      const etapaPropia = etapas.find((e) => e.departamentoId === depto.id);
      expect(etapaPropia?.permitido).toBe(true);
    });
  }

  it("Rechaza la creación cuando no existe grupo de codificación (BETA 7)", async () => {
    const beta7 = await prisma.departamento.findUnique({ where: { codigo: "BETA_7" } });
    expect(beta7).toBeDefined();
    if (!beta7) return;

    let errorLanzado: any = null;
    try {
      await defectosService.createDefecto(
        {
          defecto: "Defecto imposible en BETA 7",
          clasificacion: "MENOR",
          departamentoId: beta7.id,
          lineaId: 1,
        },
        adminUserId
      );
    } catch (e: any) {
      errorLanzado = e;
    }

    expect(errorLanzado).toBeDefined();
    expect(errorLanzado.message).toContain("pendiente de configuración");
  });

  it("Evita que dos creaciones simultáneas obtengan la misma clave (concurrencia atómica)", async () => {
    const depto = await prisma.departamento.findUnique({ where: { codigo: "CORTE" } });
    expect(depto).toBeDefined();
    if (!depto) return;

    // Ejecutar dos creaciones paralelas en Promise.all
    const [def1, def2] = await Promise.all([
      defectosService.createDefecto(
        {
          defecto: `Defecto concurrente 1 ${Date.now()}`,
          clasificacion: "MENOR",
          departamentoId: depto.id,
          lineaId: 1,
        },
        adminUserId
      ),
      defectosService.createDefecto(
        {
          defecto: `Defecto concurrente 2 ${Date.now()}`,
          clasificacion: "MENOR",
          departamentoId: depto.id,
          lineaId: 1,
        },
        adminUserId
      ),
    ]);

    idsCreados.push(def1.id, def2.id);

    // Deben tener claves diferentes y consecutivas
    expect(def1.clave).not.toBe(def2.clave);
    expect(Math.abs(def1.clave - def2.clave)).toBe(1);
    expect(def1.departamentoId).toBe(depto.id);
    expect(def2.departamentoId).toBe(depto.id);
  });

  it("Comprueba que un defecto de CORTE puede detectarse en PRELIMINARES si la matriz lo permite y la matriz no altera el propietario", async () => {
    const corte = await prisma.departamento.findUnique({ where: { codigo: "CORTE" } });
    const prelim = await prisma.departamento.findUnique({ where: { codigo: "PRELIMINARES" } });
    expect(corte && prelim).toBeTruthy();
    if (!corte || !prelim) return;

    // Crear defecto de CORTE con etapa PRELIMINARES permitida
    const def = await defectosService.createDefecto(
      {
        defecto: `Defecto CORTE detectable en PRELIMINARES ${Date.now()}`,
        clasificacion: "MENOR",
        departamentoId: corte.id,
        lineaId: 1,
        departamentosIds: [corte.id, prelim.id],
      },
      adminUserId
    );
    idsCreados.push(def.id);

    // 1. Propietario intacto en CORTE
    expect(def.departamentoId).toBe(corte.id);

    // 2. Validación de captura en etapa PRELIMINARES
    const valPrelim = await defectosService.validarDefectoParaCaptura(def.clave, prelim.id);
    expect(valPrelim.estado).toBe("VALIDO");

    // 3. Modificar la matriz de etapas para apagar PRELIMINARES
    await prisma.defectoEtapa.update({
      where: { unique_defecto_etapa: { defectoId: def.id, departamentoId: prelim.id } },
      data: { permitido: false },
    });

    // 4. Ahora en PRELIMINARES debe ser NO_PERMITIDO
    const valPrelimApagado = await defectosService.validarDefectoParaCaptura(def.clave, prelim.id);
    expect(valPrelimApagado.estado).toBe("NO_PERMITIDO");

    // 5. El departamento propietario en Defecto jamás cambió
    const defRecargado = await prisma.defecto.findUnique({ where: { id: def.id } });
    expect(defRecargado?.departamentoId).toBe(corte.id);
  });
});

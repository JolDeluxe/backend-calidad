import { describe, it, expect, beforeAll } from "bun:test";
import { prisma } from "../src/config/database";
import { InspeccionesService } from "../src/modules/inspecciones/services/inspecciones.service";
import { DefectosService } from "../src/modules/defectos/services/defectos.service";
import fs from "fs";

describe("Auditoría Exhaustiva: Matriz de Defectos por Etapas MBC", () => {
  let inspeccionesService: InspeccionesService;
  let defectosService: DefectosService;
  let deptoCorteId: number;
  let deptoPreliminaresId: number;
  let deptoMontadoId: number;
  let deptoAcabadoId: number;
  let def1101Id: number;
  let def1201Id: number;
  let def1401Id: number;
  let def1705Id: number;
  let def1632Id: number;
  let loteTest: any;

  beforeAll(async () => {
    inspeccionesService = new InspeccionesService();
    defectosService = new DefectosService();

    const corte = await prisma.departamento.findUnique({ where: { codigo: "CORTE" } });
    const preliminares = await prisma.departamento.findUnique({ where: { codigo: "PRELIMINARES" } });
    const montado = await prisma.departamento.findUnique({ where: { codigo: "MONTADO" } });
    const acabado = await prisma.departamento.findUnique({ where: { codigo: "ACABADO" } });

    deptoCorteId = corte!.id;
    deptoPreliminaresId = preliminares!.id;
    deptoMontadoId = montado!.id;
    deptoAcabadoId = acabado!.id;

    const d1101 = await prisma.defecto.findUnique({ where: { clave: 1101 } });
    const d1201 = await prisma.defecto.findUnique({ where: { clave: 1201 } });
    const d1401 = await prisma.defecto.findUnique({ where: { clave: 1401 } });
    const d1705 = await prisma.defecto.findUnique({ where: { clave: 1705 } });
    const d1632 = await prisma.defecto.findUnique({ where: { clave: 1632 } });

    def1101Id = d1101!.id;
    def1201Id = d1201!.id;
    def1401Id = d1401!.id;
    def1705Id = d1705!.id;
    def1632Id = d1632!.id;

    loteTest = await prisma.produccionLote.findFirst({
      where: { estado: "ACTIVO", eliminadoEn: null },
    });
    expect(loteTest).toBeDefined();
  });

  // =========================================================================
  // GRUPO A: PRUEBAS DE INTEGRACIÓN CON BASE DE DATOS Y MODELO RELACIONAL
  // =========================================================================
  describe("A. Integración con Base de Datos y Modelo Relacional", () => {
    it("A1. Defecto conserva su departamento propietario real independientemente de la etapa", async () => {
      const d1101 = await prisma.defecto.findUnique({
        where: { clave: 1101 },
        include: { departamento: true },
      });
      expect(d1101?.departamento.codigo).toBe("CORTE");

      const d1201 = await prisma.defecto.findUnique({
        where: { clave: 1201 },
        include: { departamento: true },
      });
      expect(d1201?.departamento.codigo).toBe("PRELIMINARES");

      const d1705 = await prisma.defecto.findUnique({
        where: { clave: 1705 },
        include: { departamento: true },
      });
      expect(d1705?.departamento.codigo).toBe("ACABADO");
    });

    it("A2. Consulta filtrada por etapaId retorna solo defectos con permitido=true en esa etapa", async () => {
      const defsCorte = await defectosService.getDefectos({
        etapaId: deptoCorteId,
        limit: 500,
      });

      const clavesCorte = defsCorte.items.map((i) => i.clave);
      expect(clavesCorte).toContain(1101);
      expect(clavesCorte).not.toContain(1201);
      expect(clavesCorte).not.toContain(1401);
      expect(clavesCorte).not.toContain(1705);

      const defsPreliminares = await defectosService.getDefectos({
        etapaId: deptoPreliminaresId,
        limit: 500,
      });
      const clavesPrelim = defsPreliminares.items.map((i) => i.clave);
      expect(clavesPrelim).toContain(1101);
      expect(clavesPrelim).toContain(1201);
      expect(clavesPrelim).not.toContain(1401);
      expect(clavesPrelim).not.toContain(1705);
    });

    it("A3. El departamento responsable en detalle se asigna desde el catálogo y no es manipulable", async () => {
      const res = await inspeccionesService.createInspeccion({
        lote: loteTest.lote,
        departamentoAuditoriaId: deptoPreliminaresId,
        usuarioId: 1,
        detalles: [
          {
            defectoId: def1101Id, // Defecto de CORTE
            defDeptoId: 9999,     // Intento de forzar o falsificar el departamento responsable
            paresDefectuosos: 1,
          },
        ],
      });

      expect(res).toBeDefined();
      expect(res.departamentoAuditoriaId).toBe(deptoPreliminaresId);
      expect(res.detalles[0].defDeptoId).toBe(deptoCorteId); // Asegura que se resolvió CORTE
    });
  });

  // =========================================================================
  // GRUPO B: PRUEBAS DE REGLAS DE NEGOCIO Y TRANSACCIONALIDAD
  // =========================================================================
  describe("B. Reglas de Negocio, Matriz de Etapas y Transaccionalidad", () => {
    it("B1. Inspección en PRELIMINARES permite registrar defecto originario de CORTE (1101)", async () => {
      const res = await inspeccionesService.createInspeccion({
        lote: loteTest.lote,
        departamentoAuditoriaId: deptoPreliminaresId,
        usuarioId: 1,
        detalles: [
          {
            defectoId: def1101Id,
            paresDefectuosos: 2,
          },
        ],
      });

      expect(res).toBeDefined();
      expect(res.departamentoAuditoriaId).toBe(deptoPreliminaresId);
      expect(res.detalles[0].defDeptoId).toBe(deptoCorteId);
    });

    it("B2. Inspección en CORTE rechaza registrar defecto no permitido en esa etapa (1201 PRELIMINARES)", async () => {
      expect(
        inspeccionesService.createInspeccion({
          lote: loteTest.lote,
          departamentoAuditoriaId: deptoCorteId,
          usuarioId: 1,
          detalles: [
            {
              defectoId: def1201Id,
              paresDefectuosos: 1,
            },
          ],
        })
      ).rejects.toThrow("no está permitido para inspección en la etapa de");
    });

    it("B3. Inspección en MONTADO rechaza registrar defecto de etapa posterior (1705 ACABADO)", async () => {
      expect(
        inspeccionesService.createInspeccion({
          lote: loteTest.lote,
          departamentoAuditoriaId: deptoMontadoId,
          usuarioId: 1,
          detalles: [
            {
              defectoId: def1705Id,
              paresDefectuosos: 1,
            },
          ],
        })
      ).rejects.toThrow("no está permitido para inspección en la etapa de");
    });

    it("B4. Transaccionalidad atómica: Un error en validación revierte toda la operación sin dejar registros huérfanos", async () => {
      const cabecerasAntes = await prisma.inspeccionCabecera.count();
      const detallesAntes = await prisma.inspeccionDetalle.count();

      // Intento de inspección combinando 1 defecto válido y 1 inválido
      await expect(
        inspeccionesService.createInspeccion({
          lote: loteTest.lote,
          departamentoAuditoriaId: deptoCorteId,
          usuarioId: 1,
          detalles: [
            { defectoId: def1101Id, paresDefectuosos: 1 }, // Válido en Corte
            { defectoId: def1705Id, paresDefectuosos: 1 }, // Inválido en Corte (bloqueado)
          ],
        })
      ).rejects.toThrow();

      const cabecerasDespues = await prisma.inspeccionCabecera.count();
      const detallesDespues = await prisma.inspeccionDetalle.count();

      expect(cabecerasDespues).toBe(cabecerasAntes);
      expect(detallesDespues).toBe(detallesAntes);
    });
  });

  // =========================================================================
  // GRUPO C: PRUEBAS DE EXCEPCIONES Y DISCREPANCIAS DEL CATÁLOGO
  // =========================================================================
  describe("C. Excepciones del Catálogo y Celdas Vacías (Clave 1632)", () => {
    it("C1. Defecto 1632 conserva su propietario AVIOS y sus etapas permitidas según archivos operativos", async () => {
      const d1632 = await prisma.defecto.findUnique({
        where: { clave: 1632 },
        include: {
          departamento: true,
          etapas: { include: { departamento: true } },
        },
      });

      expect(d1632).toBeDefined();
      expect(d1632?.departamento.codigo).toBe("AVIOS");

      const etapasPermitidas = d1632?.etapas.filter((e) => e.permitido).map((e) => e.departamento.codigo);
      expect(etapasPermitidas).toContain("MONTADO");
      expect(etapasPermitidas).toContain("ACABADO");
      expect(etapasPermitidas).toContain("AVIOS");
      expect(etapasPermitidas).not.toContain("CORTE");
      expect(etapasPermitidas).not.toContain("PRELIMINARES");
      expect(etapasPermitidas).not.toContain("PESPUNTE");
    });

    it("C2. Defecto 1632 puede registrarse en MONTADO y asigna AVIOS como departamento responsable", async () => {
      const res = await inspeccionesService.createInspeccion({
        lote: loteTest.lote,
        departamentoAuditoriaId: deptoMontadoId,
        usuarioId: 1,
        detalles: [
          {
            defectoId: def1632Id,
            paresDefectuosos: 1,
          },
        ],
      });

      expect(res).toBeDefined();
      expect(res.departamentoAuditoriaId).toBe(deptoMontadoId);
      expect(res.detalles[0].defDeptoId).toBe(deptoAcabadoId > 0 ? (await prisma.departamento.findUnique({ where: { codigo: "AVIOS" } }))!.id : 10);
    });
  });

  // =========================================================================
  // GRUPO D: VERIFICACIÓN DE PARIDAD DEL CATÁLOGO Y SINCRONIZACIÓN REAL
  // =========================================================================
  describe("D. Verificación de Paridad del Catálogo TXT vs Base de Datos", () => {
    it("D1. La totalidad de las 311 claves únicas del archivo legacy existen en MySQL", async () => {
      const filePath = "C:/Users/MBCPROEW10028/Downloads/DtaosBse/Catalogo_Def.txt";
      const content = fs.readFileSync(filePath, "latin1");
      const lines = content.split(/\r?\n/).filter(Boolean);

      const clavesTxt = new Set<number>();
      for (let i = 1; i < lines.length; i++) {
        const p = lines[i].split("\t");
        const clave = parseInt(p[2]?.trim(), 10);
        if (clave) clavesTxt.add(clave);
      }

      expect(clavesTxt.size).toBe(311);

      const countEnDb = await prisma.defecto.count({
        where: { clave: { in: Array.from(clavesTxt) } },
      });

      expect(countEnDb).toBe(311);
    });

    it("D2. No existen discrepancias entre los valores R/T del archivo TXT y defectos_etapas", async () => {
      const filePath = "C:/Users/MBCPROEW10028/Downloads/DtaosBse/Catalogo_Def.txt";
      const content = fs.readFileSync(filePath, "latin1");
      const lines = content.split(/\r?\n/).filter(Boolean);

      const colEtapas = [
        { name: "Corte", codigo: "CORTE", colIdx: 6 },
        { name: "Preliminares", codigo: "PRELIMINARES", colIdx: 7 },
        { name: "Kit Complementos", codigo: "KIT_COMPLEMENTOS", colIdx: 8 },
        { name: "Bordado y Laser", codigo: "BORDADO_LASER", colIdx: 9 },
        { name: "Pespunte", codigo: "PESPUNTE", colIdx: 10 },
        { name: "Montado", codigo: "MONTADO", colIdx: 11 },
        { name: "Avios", codigo: "AVIOS", colIdx: 12 },
        { name: "Acabado", codigo: "ACABADO", colIdx: 13 },
        { name: "Adorno", codigo: "ADORNO", colIdx: 14 },
      ];

      const deptos = await prisma.departamento.findMany();
      const deptoIdPorCodigo = new Map(deptos.map((d) => [d.codigo, d.id]));

      let discrepancias = 0;

      for (let i = 1; i < lines.length; i++) {
        const p = lines[i].split("\t");
        const clave = parseInt(p[2]?.trim(), 10);
        if (!clave) continue;

        const def = await prisma.defecto.findUnique({
          where: { clave },
          include: { etapas: true },
        });

        const etapasDb = new Map(def?.etapas.map((e) => [e.departamentoId, e.permitido]));

        for (const col of colEtapas) {
          const deptoId = deptoIdPorCodigo.get(col.codigo);
          if (!deptoId) continue; // Si la etapa no es de la línea BOTA (ej. KIT_COMPLEMENTOS que no pertenece a BOTA)
          const valTxt = p[col.colIdx]?.trim();
          let esperado = false;

          if (valTxt === "R") esperado = true;
          else if (valTxt === "T") esperado = false;
          else if (clave === 1632) {
            // Excepción documentada: 1632 activo en Montado, Avíos, Acabado
            esperado = ["MONTADO", "AVIOS", "ACABADO"].includes(col.codigo);
          } else {
            esperado = false;
          }

          const real = etapasDb.get(deptoId);
          if (real !== esperado) {
            discrepancias++;
          }
        }
      }

      expect(discrepancias).toBe(0);
    });
  });
});

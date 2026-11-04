import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../src/config/database";
import { defectosService } from "../src/modules/defectos/services/defectos.service";

describe("Creación de Defectos con Clave Manual Directa", () => {
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

  it("Permite crear un defecto con clave manual sin depender de configuración previa", async () => {
    const corte = await prisma.departamento.findUnique({ where: { codigo: "CORTE" } });
    expect(corte).toBeDefined();
    if (!corte) return;

    const claveManual = 88991; // Clave libre arbitraria que el usuario decide
    const nuevo = await defectosService.createDefecto(
      {
        clave: claveManual,
        defecto: `Defecto manual sin ataduras ${Date.now()}`,
        clasificacion: "CRITICO",
        departamentoId: corte.id,
      },
      adminUserId
    );

    idsCreados.push(nuevo.id);
    expect(nuevo.clave).toBe(claveManual);
    expect(nuevo.departamentoId).toBe(corte.id);

    // Matriz sincronizada automáticamente
    const etapas = await prisma.defectoEtapa.findMany({ where: { defectoId: nuevo.id } });
    expect(etapas.length).toBeGreaterThan(0);
    const etapaCorte = etapas.find((e) => e.departamentoId === corte.id);
    expect(etapaCorte?.permitido).toBe(true);
  });

  it("Rechaza si la clave manual ya está ocupada por otro defecto", async () => {
    const depto = await prisma.departamento.findFirst({ where: { estado: "ACTIVO" } });
    expect(depto).toBeDefined();
    if (!depto) return;

    // Tomar un defecto existente
    const existente = await prisma.defecto.findFirst({ select: { clave: true } });
    expect(existente).toBeDefined();
    if (!existente) return;

    let error: any = null;
    try {
      await defectosService.createDefecto(
        {
          clave: existente.clave,
          defecto: "Intento duplicado",
          clasificacion: "MENOR",
          departamentoId: depto.id,
        },
        adminUserId
      );
    } catch (e: any) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.message).toContain("Ya existe un defecto registrado con la clave");
  });
});

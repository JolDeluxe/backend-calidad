import { describe, it, expect, beforeAll } from "bun:test";
import { prisma } from "../src/config/database";
import { defectosService } from "../src/modules/defectos/services/defectos.service";
import { codificacionDefectosService } from "../src/modules/defectos/services/codificacion-defectos.service";
import { matrizVisibilidadDefectosService } from "../src/modules/defectos/services/matriz-visibilidad.service";
import { inspeccionesService } from "../src/modules/inspecciones/services/inspecciones.service";

describe("Integración: Matriz de Visibilidad en Creación e Inspecciones", () => {
  let deptoCorteId: number;
  let deptoAcabadoId: number;
  let deptoAdornoId: number;

  beforeAll(async () => {
    const deptos = await prisma.departamento.findMany({ select: { id: true, codigo: true } });
    const mapa = new Map(deptos.map((d) => [d.codigo, d.id]));
    deptoCorteId = mapa.get("CORTE")!;
    deptoAcabadoId = mapa.get("ACABADO")!;
    deptoAdornoId = mapa.get("ADORNO")!;
  });

  it("Defecto nuevo individual de CORTE hereda automáticamente la matriz maestra (sin excepciones en DefectoEtapa)", async () => {
    const claveAleatoria = 98000 + Math.floor(Math.random() * 800) + Math.floor(Date.now() % 100);
    const nuevo = await defectosService.createDefecto(
      {
        clave: claveAleatoria,
        defecto: `Defecto herencia individual ${claveAleatoria}`,
        clasificacion: "CRITICO",
        departamentoId: deptoCorteId,
      },
      1
    );

    // En la arquitectura corregida, la herencia dinámica NO crea filas en DefectoEtapa
    const etapas = await prisma.defectoEtapa.findMany({ where: { defectoId: nuevo.id } });
    expect(etapas.length).toBe(0);

    // La resolución dinámica consulta la matriz maestra
    const resAcabado = await matrizVisibilidadDefectosService.resolverVisibilidad(nuevo.id, deptoAcabadoId);
    expect(resAcabado.permitido).toBe(true);
    expect(resAcabado.origenRegla).toBe("MATRIZ");

    const resAdorno = await matrizVisibilidadDefectosService.resolverVisibilidad(nuevo.id, deptoAdornoId);
    expect(resAdorno.permitido).toBe(false);
    expect(resAdorno.origenRegla).toBe("MATRIZ");
  });

  it("Defecto nuevo en carga masiva de CORTE hereda automáticamente la matriz maestra (sin excepciones en DefectoEtapa)", async () => {
    const claveAleatoria = 96000 + Math.floor(Math.random() * 800) + Math.floor(Date.now() % 100);
    const resultadoLote = await codificacionDefectosService.crearLote(
      {
        lineaId: 1,
        departamentoId: deptoCorteId,
        filas: [
          {
            clave: claveAleatoria,
            descripcion: `Defecto lote matriz ${claveAleatoria}`,
            clasificacion: "MAYOR",
          },
        ],
      },
      1
    );

    const creado = resultadoLote.items[0];
    const etapas = await prisma.defectoEtapa.findMany({ where: { defectoId: creado.id } });
    expect(etapas.length).toBe(0);

    const resAcabado = await matrizVisibilidadDefectosService.resolverVisibilidad(creado.id, deptoAcabadoId);
    expect(resAcabado.permitido).toBe(true);
    expect(resAcabado.origenRegla).toBe("MATRIZ");

    const resAdorno = await matrizVisibilidadDefectosService.resolverVisibilidad(creado.id, deptoAdornoId);
    expect(resAdorno.permitido).toBe(false);
    expect(resAdorno.origenRegla).toBe("MATRIZ");
  });

  it("Inspección rechaza registrar un defecto en una etapa bloqueada por la matriz", async () => {
    // Defecto de corte
    const defCorte = await prisma.defecto.findFirst({
      where: { departamentoId: deptoCorteId, activo: true, eliminadoEn: null },
    });
    expect(defCorte).not.toBeNull();

    const loteValido = await prisma.produccionLote.findFirst({
      where: { estado: "ACTIVO", eliminadoEn: null },
    });
    expect(loteValido).not.toBeNull();

    // Intentar inspección en etapa ADORNO (bloqueada para CORTE)
    expect(
      inspeccionesService.createInspeccion({
        lote: loteValido!.lote,
        usuarioId: 1,
        detalles: [{ defectoId: defCorte!.id, paresDefectuosos: 1 }],
        terminal: {
          id: 1,
          nombre: "TERMINAL-TEST",
          departamentoId: deptoAdornoId, // Etapa ADORNO
        },
      })
    ).rejects.toThrow("no está permitido para inspección en la etapa de");
  });
});

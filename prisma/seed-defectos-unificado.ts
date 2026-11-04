import { prisma } from "../src/config/database";
import * as fs from "fs";
import * as path from "path";

/**
 * Seed oficial unificado y reproducible del catálogo de defectos (289 items).
 * Mapea exactamente los departamentos y claves del archivo 'catalogo_def_unificado_corregido.xlsx'.
 * Idempotente: actualiza nombres y departamentos si existen, inserta nuevos si faltan,
 * y desactiva lógicamente cualquier defecto previo no listado para mantener la integridad histórica.
 */
export async function seedDefectosUnificado() {
  console.log("=================================================================");
  console.log("Sincronizando Catálogo Unificado Oficial de Defectos (289)");
  console.log("=================================================================");

  const jsonPath = path.resolve(__dirname, "./data/catalogo_unificado_289.json");
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Archivo no encontrado: ${jsonPath}`);
  }

  const defectosData: Array<{
    num: number;
    clave: number;
    departamentoCodigo: string;
    departamentoNombre: string;
    defecto: string;
    clasificacion: "CRITICO" | "MAYOR" | "MENOR";
    estadoOrigen?: string;
  }> = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

  const deptos = await prisma.departamento.findMany();
  const mapDeptos = new Map<string, number>();
  deptos.forEach((d) => mapDeptos.set(d.codigo, d.id));

  // Asegurar PREMONTADO
  if (!mapDeptos.has("PREMONTADO")) {
    const nuevo = await prisma.departamento.create({
      data: {
        codigo: "PREMONTADO",
        nombre: "PREMONTADO",
        estado: "ACTIVO",
        numeroLineas: 1,
      },
    });
    mapDeptos.set("PREMONTADO", nuevo.id);
  }

  let actualizados = 0;
  let creados = 0;

  for (const item of defectosData) {
    const deptoId = mapDeptos.get(item.departamentoCodigo);
    if (!deptoId) continue;

    const existente = await prisma.defecto.findUnique({
      where: { clave: item.clave },
    });

    if (existente) {
      await prisma.defecto.update({
        where: { clave: item.clave },
        data: {
          defecto: item.defecto,
          clasificacion: item.clasificacion,
          departamentoId: deptoId,
          activo: true,
          eliminadoEn: null,
          eliminadoPor: null,
        },
      });
      actualizados++;
    } else {
      await prisma.defecto.create({
        data: {
          clave: item.clave,
          defecto: item.defecto,
          clasificacion: item.clasificacion,
          departamentoId: deptoId,
          activo: true,
          creadoPor: 1,
        },
      });
      creados++;
    }
  }

  // Inactivar defectos que ya no forman parte del catálogo oficial
  const clavesValidas = new Set(defectosData.map((d) => d.clave));
  await prisma.defecto.updateMany({
    where: {
      clave: { notIn: Array.from(clavesValidas) },
      eliminadoEn: null,
    },
    data: {
      activo: false,
      eliminadoEn: new Date(),
      eliminadoPor: 1,
    },
  });

  // Sincronizar grupos de codificación con los consecutivos reales de los 289 defectos
  const lineaBota = await prisma.linea.findFirst({ where: { codigo: "BOTA" } });
  if (lineaBota) {
    const gruposSiguientes: Record<number, { deptoCodigo: string; siguiente: number }> = {
      11: { deptoCodigo: "CORTE", siguiente: 26 },
      12: { deptoCodigo: "PRELIMINARES", siguiente: 60 },
      13: { deptoCodigo: "BORDADO_Y_LASER", siguiente: 21 },
      14: { deptoCodigo: "PESPUNTE", siguiente: 71 },
      15: { deptoCodigo: "MONTADO", siguiente: 48 },
      16: { deptoCodigo: "AVIOS", siguiente: 33 },
      17: { deptoCodigo: "ACABADO", siguiente: 67 },
      18: { deptoCodigo: "ADORNO", siguiente: 39 },
      19: { deptoCodigo: "PREMONTADO", siguiente: 4 },
    };

    for (const [prefijoStr, config] of Object.entries(gruposSiguientes)) {
      const prefijo = Number(prefijoStr);
      const deptoId = mapDeptos.get(config.deptoCodigo);
      if (!deptoId) continue;

      // Asegurar asignación en departamento_linea
      await prisma.departamentoLinea.upsert({
        where: {
          unique_depto_linea: {
            departamentoId: deptoId,
            lineaId: lineaBota.id,
          },
        },
        update: { activo: true, eliminadoEn: null },
        create: {
          departamentoId: deptoId,
          lineaId: lineaBota.id,
          activo: true,
        },
      });

      await prisma.grupoCodificacionDefecto.upsert({
        where: {
          unique_grupo_linea_depto: {
            lineaId: lineaBota.id,
            departamentoId: deptoId,
          },
        },
        update: {
          prefijo,
          siguienteConsecutivo: config.siguiente,
          activo: true,
        },
        create: {
          prefijo,
          lineaId: lineaBota.id,
          departamentoId: deptoId,
          siguienteConsecutivo: config.siguiente,
          activo: true,
        },
      });
    }
  }

  console.log(`✓ Catálogo unificado de defectos sincronizado (${creados} creados, ${actualizados} actualizados).`);
  console.log(`✓ Grupos de codificación 11-19 actualizados con consecutivos exactos.`);
}

if (import.meta.main) {
  seedDefectosUnificado()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
}

import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";

// Estructura de respaldo oficial
interface RespaldoOfflineItem {
  idLocalCliente: string;
  inspectorId: number;
  inspectorUsuario: string;
  inspectorNombre: string;
  terminalId: number;
  terminalNombre: string;
  departamentoAuditoriaId: number;
  offlineToken: string;
  fechaCapturaDispositivo: string;
  esContingencia: boolean;
  motivoContingencia: string | null;
  payload: {
    lote: string;
    lineaId: number | null;
    lineaTexto: string | null;
    horma: string | null;
    notas: string | null;
    detalles: Array<{
      defectoId: number;
      defectoClave?: number;
      defectoNombre?: string;
      clasificacion?: "CRITICO" | "MAYOR" | "MENOR";
      defDeptoId?: number;
      defDeptoNombre?: string;
      paresDefectuosos: number;
      notas?: string;
    }>;
  };
  payloadHash: string;
}

interface RespaldoOfflineArchivo {
  magicHeader: "MBC_OFFLINE_BACKUP";
  version: "1.0.0";
  sistema: "MBC_CALIDAD";
  generadoEn: string;
  terminal?: {
    id?: number;
    nombre?: string;
    departamentoId?: number;
    departamentoCodigo?: string;
    departamentoNombre?: string;
  };
  totalRegistros: number;
  checksumSha256: string;
  registros: RespaldoOfflineItem[];
}

function computeSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function computeCanonicalPayloadHash(payload: {
  lote: string;
  lineaId?: number | null;
  detalles: Array<{ defectoId: number; paresDefectuosos: number }>;
}): string {
  const canonicalDetalles = [...payload.detalles]
    .map((d) => `${d.defectoId}:${d.paresDefectuosos}`)
    .sort()
    .join("|");
  const canonicalString = `${payload.lote.trim().toUpperCase()}::${payload.lineaId ?? "null"}::${canonicalDetalles}`;
  return createHash("sha256").update(canonicalString).digest("hex");
}

function validarArchivoRespaldoTest(
  contenidoTexto: string,
  colaExistente: Array<{ idLocalCliente: string; payloadHash: string }>,
) {
  try {
    const parsed = JSON.parse(contenidoTexto) as RespaldoOfflineArchivo;

    if (!parsed || parsed.magicHeader !== "MBC_OFFLINE_BACKUP") {
      return { valido: false, error: "Magic header incorrecto" };
    }
    if (parsed.version !== "1.0.0") {
      return { valido: false, error: `Versión no compatible (${parsed.version})` };
    }
    if (!Array.isArray(parsed.registros) || parsed.registros.length === 0) {
      return { valido: false, error: "Sin registros de inspección" };
    }

    // Checksum global SHA-256
    const canonicalPayloadString = JSON.stringify(parsed.registros);
    const computedChecksum = computeSha256(canonicalPayloadString);
    if (computedChecksum !== parsed.checksumSha256) {
      return { valido: false, error: "Checksum SHA-256 alterado o corrupto" };
    }

    const mapaCola = new Map(colaExistente.map((i) => [i.idLocalCliente, i]));
    let nuevos = 0;
    let duplicados = 0;
    let conflictos = 0;

    for (const reg of parsed.registros) {
      const existe = mapaCola.get(reg.idLocalCliente);
      if (existe) {
        if (existe.payloadHash === reg.payloadHash) {
          duplicados++;
        } else {
          conflictos++;
        }
      } else {
        nuevos++;
      }
    }

    return {
      valido: true,
      resumen: {
        total: parsed.registros.length,
        nuevos,
        duplicados,
        conflictos,
      },
    };
  } catch (err: any) {
    return { valido: false, error: "JSON inválido" };
  }
}

describe("Blindaje Offline: Integridad Criptográfica y Reconciliación de Archivos .mbcbak", () => {
  const item1: RespaldoOfflineItem = {
    idLocalCliente: "11111111-1111-4111-8111-111111111111",
    inspectorId: 10,
    inspectorUsuario: "inspector_corte",
    inspectorNombre: "Inspector Corte",
    terminalId: 1,
    terminalNombre: "PC-CORTE-01",
    departamentoAuditoriaId: 1,
    offlineToken: "valid_token_1",
    fechaCapturaDispositivo: "2026-11-12T10:00:00.000Z",
    esContingencia: false,
    motivoContingencia: null,
    payload: {
      lote: "LOTE-2026-A",
      lineaId: 1,
      lineaTexto: "Línea 1",
      horma: "H-500",
      notas: "Sin observaciones",
      detalles: [{ defectoId: 101, paresDefectuosos: 3, clasificacion: "MAYOR" }],
    },
    payloadHash: computeCanonicalPayloadHash({
      lote: "LOTE-2026-A",
      lineaId: 1,
      detalles: [{ defectoId: 101, paresDefectuosos: 3 }],
    }),
  };

  const item2: RespaldoOfflineItem = {
    idLocalCliente: "22222222-2222-4222-8222-222222222222",
    inspectorId: 10,
    inspectorUsuario: "inspector_corte",
    inspectorNombre: "Inspector Corte",
    terminalId: 1,
    terminalNombre: "PC-CORTE-01",
    departamentoAuditoriaId: 1,
    offlineToken: "valid_token_2",
    fechaCapturaDispositivo: "2026-11-12T10:15:00.000Z",
    esContingencia: false,
    motivoContingencia: null,
    payload: {
      lote: "LOTE-2026-B",
      lineaId: 1,
      lineaTexto: "Línea 1",
      horma: "H-500",
      notas: "Revisión talón",
      detalles: [{ defectoId: 102, paresDefectuosos: 1, clasificacion: "CRITICO" }],
    },
    payloadHash: computeCanonicalPayloadHash({
      lote: "LOTE-2026-B",
      lineaId: 1,
      detalles: [{ defectoId: 102, paresDefectuosos: 1 }],
    }),
  };

  it("1. Generación y Validación de Respaldo Legítimo con Checksum SHA-256", () => {
    const registros = [item1, item2];
    const canonicalString = JSON.stringify(registros);
    const checksumSha256 = computeSha256(canonicalString);

    const archivoValido: RespaldoOfflineArchivo = {
      magicHeader: "MBC_OFFLINE_BACKUP",
      version: "1.0.0",
      sistema: "MBC_CALIDAD",
      generadoEn: new Date().toISOString(),
      terminal: {
        id: 1,
        nombre: "PC-CORTE-01",
        departamentoCodigo: "CORTE",
        departamentoNombre: "Corte",
      },
      totalRegistros: 2,
      checksumSha256,
      registros,
    };

    const textoArchivo = JSON.stringify(archivoValido);
    const resultado = validarArchivoRespaldoTest(textoArchivo, []);

    expect(resultado.valido).toBe(true);
    expect(resultado.resumen?.total).toBe(2);
    expect(resultado.resumen?.nuevos).toBe(2);
    expect(resultado.resumen?.duplicados).toBe(0);
    expect(resultado.resumen?.conflictos).toBe(0);
  });

  it("2. Detección Inmediata de Manipulación o Corrupción (Tamper Proof) en Checksum SHA-256", () => {
    const registros = [item1, item2];
    const canonicalString = JSON.stringify(registros);
    const checksumSha256 = computeSha256(canonicalString);

    // Alterar 1 detalle en el registro (cambiar pares defectuosos de 3 a 99)
    const registrosAlterados = JSON.parse(JSON.stringify(registros));
    registrosAlterados[0].payload.detalles[0].paresDefectuosos = 99;

    const archivoAlterado: RespaldoOfflineArchivo = {
      magicHeader: "MBC_OFFLINE_BACKUP",
      version: "1.0.0",
      sistema: "MBC_CALIDAD",
      generadoEn: new Date().toISOString(),
      totalRegistros: 2,
      checksumSha256, // Checksum original no coincide con el contenido modificado
      registros: registrosAlterados,
    };

    const resultado = validarArchivoRespaldoTest(JSON.stringify(archivoAlterado), []);
    expect(resultado.valido).toBe(false);
    expect(resultado.error).toContain("Checksum SHA-256 alterado o corrupto");
  });

  it("3. Rechazo de Archivos Foráneos o Magic Header Inválido", () => {
    const archivoFalso = {
      magicHeader: "OTRO_SISTEMA_DIFERENTE",
      version: "1.0.0",
      registros: [item1],
      checksumSha256: "dummy",
    };

    const resultado = validarArchivoRespaldoTest(JSON.stringify(archivoFalso), []);
    expect(resultado.valido).toBe(false);
    expect(resultado.error).toContain("Magic header incorrecto");
  });

  it("4. Reconciliación Idempotente: Deduplicación exacta sin sobrescribir ni duplicar", () => {
    const registros = [item1, item2];
    const checksumSha256 = computeSha256(JSON.stringify(registros));

    const archivo: RespaldoOfflineArchivo = {
      magicHeader: "MBC_OFFLINE_BACKUP",
      version: "1.0.0",
      sistema: "MBC_CALIDAD",
      generadoEn: new Date().toISOString(),
      totalRegistros: 2,
      checksumSha256,
      registros,
    };

    // La base de datos local YA tiene el item1 con el mismo hash, pero NO tiene el item2
    const colaExistente = [{ idLocalCliente: item1.idLocalCliente, payloadHash: item1.payloadHash }];

    const resultado = validarArchivoRespaldoTest(JSON.stringify(archivo), colaExistente);
    expect(resultado.valido).toBe(true);
    expect(resultado.resumen?.total).toBe(2);
    expect(resultado.resumen?.nuevos).toBe(1); // item2 se importará
    expect(resultado.resumen?.duplicados).toBe(1); // item1 se omitirá
    expect(resultado.resumen?.conflictos).toBe(0);
  });

  it("5. Detección de Conflicto de Idempotencia si el ID coincide pero el contenido difiere", () => {
    const registros = [item1];
    const checksumSha256 = computeSha256(JSON.stringify(registros));

    const archivo: RespaldoOfflineArchivo = {
      magicHeader: "MBC_OFFLINE_BACKUP",
      version: "1.0.0",
      sistema: "MBC_CALIDAD",
      generadoEn: new Date().toISOString(),
      totalRegistros: 1,
      checksumSha256,
      registros,
    };

    // La base local tiene el mismo UUID pero con un payloadHash distinto
    const colaExistente = [
      { idLocalCliente: item1.idLocalCliente, payloadHash: "hash_completamente_distinto" },
    ];

    const resultado = validarArchivoRespaldoTest(JSON.stringify(archivo), colaExistente);
    expect(resultado.valido).toBe(true);
    expect(resultado.resumen?.conflictos).toBe(1);
    expect(resultado.resumen?.nuevos).toBe(0);
  });
});

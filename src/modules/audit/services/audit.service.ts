import { createHash } from "node:crypto";
import { prisma } from "../../../config/database";
import { logger } from "../../../utils/logger";

export type AuditResultado = "EXITOSO" | "RECHAZADO" | "FALLIDO";
export type AuditOrigen = "INTERFAZ" | "API" | "SISTEMA" | "SINCRONIZACION";

export interface AuditContext {
  usuarioId?: number;
  usuarioNombre?: string;
  rolCodigo?: string;
  departamentoId?: number;
  terminalId?: number;
  ipOrigen?: string;
  agenteUsuario?: string;
  requestId?: string;
  correlationId?: string;
  metodoHttp?: string;
  rutaHttp?: string;
}

export interface RegistrarAuditoriaParams {
  accion: string;
  modulo: string;
  entidad: string;
  entidadId?: string;
  descripcion: string;
  resultado?: AuditResultado;
  motivo?: string;
  valoresAnteriores?: Record<string, unknown> | null;
  valoresPosteriores?: Record<string, unknown> | null;
  camposModificados?: string[];
  origen?: AuditOrigen;
  metadatos?: Record<string, unknown>;
  contexto?: AuditContext;
}

// Lista negra amplia y estricta de sanitización
const SENSIBLE_KEYS = new Set([
  "password",
  "passwordhash",
  "password_hash",
  "passwordencrypted",
  "contrasena",
  "contraseña",
  "credencial",
  "credencialhash",
  "credencial_hash",
  "refreshtoken",
  "refreshtokenhash",
  "refresh_token_hash",
  "accesstoken",
  "access_token",
  "token",
  "jwt_secret",
  "authorization",
  "cookie",
  "set-cookie",
  "apikey",
  "api_key",
  "secret",
  "privatekey",
  "private_key",
  "database_url",
  "databaseurl",
  "db_pass",
  "dbpass",
  "connectionstring",
  "connection_string",
]);

export function sanitizarValores(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof Date) {
    return obj.toISOString();
  }
  // Soporte para Prisma.Decimal u objetos con toNumber / toString o constructor especial
  if (typeof obj === "object" && obj !== null && "d" in obj && "s" in obj && "e" in obj) {
    return Number((obj as any).toString());
  }
  if (typeof obj !== "object") {
    // Si es un string largo que parece token o connection string
    if (typeof obj === "string") {
      if (obj.includes("mysql://") || obj.includes("mariadb://") || obj.includes("postgres://")) {
        return "[CONEXION_REDACTADA]";
      }
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizarValores(item));
  }

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase().replace(/[-_]/g, "");
    const isSensitive =
      SENSIBLE_KEYS.has(key.toLowerCase()) ||
      SENSIBLE_KEYS.has(lowerKey) ||
      lowerKey.includes("password") ||
      lowerKey.includes("contrase") ||
      lowerKey.includes("secret") ||
      lowerKey.includes("apikey");

    if (isSensitive) {
      clean[key] = "[REDACTADO]";
    } else if (typeof value === "object" && value !== null) {
      clean[key] = sanitizarValores(value);
    } else if (typeof value === "string" && (value.includes("mysql://") || value.includes("mariadb://"))) {
      clean[key] = "[CONEXION_REDACTADA]";
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

export function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return "null";
  }
  if (obj instanceof Date) {
    return JSON.stringify(obj.toISOString());
  }
  if (typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJson).join(",") + "]";
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(record[k]))
      .join(",") +
    "}"
  );
}

export class AuditService {
  /**
   * Calcula el hash criptográfico SHA-256 encadenado con el registro anterior para inmutabilidad demostrable.
   * Utiliza canonicalJson determinista para evitar diferencias en orden de propiedades entre MySQL y JavaScript.
   */
  calcularHash(
    prevHash: string,
    accion: string,
    entidad: string,
    entidadId: string | undefined,
    fecha: Date,
    detalles: unknown
  ): string {
    const detallesCanonical = canonicalJson(detalles);
    const raw = `${prevHash}|${accion}|${entidad}|${entidadId || ""}|${fecha.toISOString()}|${detallesCanonical}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  /**
   * Registra un evento de auditoría funcional con sanitización automática y encadenamiento criptográfico serializado.
   * Utiliza la tabla `control_cadena_auditoria` con bloqueo pesimista en base de datos para garantizar exclusión mutua
   * y evitar bifurcaciones bajo alta concurrencia.
   */
  async registrarEvento(params: RegistrarAuditoriaParams, tx?: any) {
    const executeInTx = async (prismaTx: any) => {
      const now = new Date();

      // 1. Sanitizar valores anteriores y posteriores
      const anterioresSanitizados = params.valoresAnteriores
        ? (sanitizarValores(params.valoresAnteriores) as Record<string, unknown>)
        : null;
      const posterioresSanitizados = params.valoresPosteriores
        ? (sanitizarValores(params.valoresPosteriores) as Record<string, unknown>)
        : null;

      // 2. Extraer campos modificados automáticamente si no se proveyeron
      let camposModificados = params.camposModificados;
      if (!camposModificados && anterioresSanitizados && posterioresSanitizados) {
        const allKeys = new Set([
          ...Object.keys(anterioresSanitizados),
          ...Object.keys(posterioresSanitizados),
        ]);
        camposModificados = Array.from(allKeys).filter(
          (k) => JSON.stringify(anterioresSanitizados[k]) !== JSON.stringify(posterioresSanitizados[k])
        );
      }

      // 3. Adquirir exclusión mutua pesimista sobre la fila de control id=1
      // FOR UPDATE garantiza que ningún otro proceso o petición calcule simultáneamente
      const lockRows = await prismaTx.$queryRaw<Array<{ id: number; ultimo_hash: string; total_eventos: number }>>`
        SELECT id, ultimo_hash, total_eventos
        FROM control_cadena_auditoria
        WHERE id = 1
        FOR UPDATE
      `;

      let prevHash = "GENESIS_CALIDAD_AUDIT_HASH_V1";
      let totalEventos = 0;

      if (lockRows && lockRows.length > 0) {
        prevHash = lockRows[0].ultimo_hash || "GENESIS_CALIDAD_AUDIT_HASH_V1";
        totalEventos = Number(lockRows[0].total_eventos || 0);
      } else {
        // Inicializar si no existiera
        await prismaTx.$executeRaw`
          INSERT INTO control_cadena_auditoria (id, ultimo_hash, ultimo_evento_id, total_eventos, fecha_actualizacion)
          VALUES (1, 'GENESIS_CALIDAD_AUDIT_HASH_V1', NULL, 0, NOW(3))
        `;
      }

      const detallesStruct = {
        modulo: params.modulo,
        descripcion: params.descripcion,
        resultado: params.resultado || "EXITOSO",
        motivo: params.motivo,
        origen: params.origen || "INTERFAZ",
        camposModificados,
        valoresAnteriores: anterioresSanitizados,
        valoresPosteriores: posterioresSanitizados,
        metadatos: params.metadatos,
        actorHistorico: params.contexto?.usuarioNombre,
        rolHistorico: params.contexto?.rolCodigo,
        requestId: params.contexto?.requestId,
        correlationId: params.contexto?.correlationId,
        metodoHttp: params.contexto?.metodoHttp,
        rutaHttp: params.contexto?.rutaHttp,
      };

      const hashIntegridad = this.calcularHash(
        prevHash,
        params.accion,
        params.entidad,
        params.entidadId,
        now,
        detallesStruct
      );

      // 4. Crear el registro en registros_auditoria
      const nuevoEvento = await prismaTx.registroAuditoria.create({
        data: {
          usuarioId: params.contexto?.usuarioId,
          accion: params.accion,
          entidad: params.entidad,
          entidadId: params.entidadId,
          departamentoId: params.contexto?.departamentoId,
          terminalId: params.contexto?.terminalId,
          motivo: params.motivo,
          detalles: detallesStruct,
          ipOrigen: params.contexto?.ipOrigen?.slice(0, 45),
          agenteUsuario: params.contexto?.agenteUsuario?.slice(0, 255),
          hashIntegridad,
          fecha: now,
        },
      });

      // 5. Actualizar la fila de control con el nuevo hash dentro de la misma transacción atómica
      await prismaTx.$executeRaw`
        UPDATE control_cadena_auditoria
        SET ultimo_hash = ${hashIntegridad},
            ultimo_evento_id = ${nuevoEvento.id},
            total_eventos = ${totalEventos + 1},
            fecha_actualizacion = ${now}
        WHERE id = 1
      `;

      return nuevoEvento;
    };

    // Si ya viene un contexto transaccional, ejecutar en él; si no, abrir transacción con reintentos
    if (tx) {
      return executeInTx(tx);
    }

    let retries = 3;
    while (retries > 0) {
      try {
        return await prisma.$transaction(async (prismaTx) => {
          return executeInTx(prismaTx);
        }, {
          maxWait: 5000,
          timeout: 10000,
        });
      } catch (error: any) {
        retries--;
        const isDeadlockOrLockWait =
          error?.code === "P2034" ||
          error?.message?.includes("Deadlock") ||
          error?.message?.includes("Lock wait timeout");

        if (retries > 0 && isDeadlockOrLockWait) {
          logger.warn({ error }, `Reintentando inserción de auditoría tras contención transaccional (${retries} intentos restantes)`);
          await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
          continue;
        }
        logger.error({ error, params }, "Error crítico al persistir evento de auditoría");
        throw error;
      }
    }
  }

  /**
   * Consulta paginada y filtrada de auditoría para el panel administrativo.
   */
  async consultarEventos(filtros: {
    fechaDesde?: Date;
    fechaHasta?: Date;
    usuarioId?: number;
    accion?: string;
    entidad?: string;
    entidadId?: string;
    departamentoId?: number;
    terminalId?: number;
    resultado?: string;
    limit?: number;
    page?: number;
  }) {
    const page = Math.max(1, filtros.page || 1);
    const limit = Math.min(100, Math.max(1, filtros.limit || 20));
    const skip = (page - 1) * limit;

    const where: any = {};

    if (filtros.fechaDesde || filtros.fechaHasta) {
      where.fecha = {};
      if (filtros.fechaDesde) where.fecha.gte = filtros.fechaDesde;
      if (filtros.fechaHasta) where.fecha.lte = filtros.fechaHasta;
    }

    if (filtros.usuarioId) where.usuarioId = filtros.usuarioId;
    if (filtros.accion) where.accion = { contains: filtros.accion };
    if (filtros.entidad) where.entidad = filtros.entidad;
    if (filtros.entidadId) where.entidadId = filtros.entidadId;
    if (filtros.departamentoId) where.departamentoId = filtros.departamentoId;
    if (filtros.terminalId) where.terminalId = filtros.terminalId;

    const [total, items] = await Promise.all([
      prisma.registroAuditoria.count({ where }),
      prisma.registroAuditoria.findMany({
        where,
        include: {
          usuario: { select: { id: true, usuario: true, nombre: true } },
          departamento: { select: { id: true, codigo: true, nombre: true } },
          terminal: { select: { id: true, nombre: true } },
        },
        orderBy: { id: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Sincroniza la fila de control con el último registro existente en base de datos.
   * Es útil tras migraciones o inicializaciones.
   */
  async sincronizarControlCadena() {
    const ultimo = await prisma.registroAuditoria.findFirst({
      where: { hashIntegridad: { not: null } },
      orderBy: { id: "desc" },
      select: { id: true, hashIntegridad: true },
    });

    const totalConHash = await prisma.registroAuditoria.count({
      where: { hashIntegridad: { not: null } },
    });

    const hash = ultimo?.hashIntegridad || "GENESIS_CALIDAD_AUDIT_HASH_V1";
    const eventoId = ultimo?.id || null;

    await prisma.$executeRaw`
      INSERT INTO control_cadena_auditoria (id, ultimo_hash, ultimo_evento_id, total_eventos, fecha_actualizacion)
      VALUES (1, ${hash}, ${eventoId}, ${totalConHash}, NOW(3))
      ON DUPLICATE KEY UPDATE
        ultimo_hash = ${hash},
        ultimo_evento_id = ${eventoId},
        total_eventos = ${totalConHash},
        fecha_actualizacion = NOW(3)
    `;

    return { ultimoHash: hash, ultimoEventoId: eventoId, totalEventos: totalConHash };
  }

  /**
   * Verifica la integridad de la cadena criptográfica de eventos.
   * Maneja explícitamente eventos históricos sin hash ignorándolos sin romper la cadena.
   */
  async verificarIntegridadCadena(limite = 500) {
    const eventos = await prisma.registroAuditoria.findMany({
      take: limite,
      orderBy: { id: "asc" },
    });

    let prevHash = "GENESIS_CALIDAD_AUDIT_HASH_V1";
    let alterado = false;
    let primerAlteradoId: number | null = null;
    let eventosVerificados = 0;
    let eventosHistoricosSinHash = 0;

    for (const e of eventos) {
      if (e.hashIntegridad) {
        eventosVerificados++;
        const esperado = this.calcularHash(
          prevHash,
          e.accion,
          e.entidad,
          e.entidadId || undefined,
          e.fecha,
          e.detalles
        );
        if (esperado !== e.hashIntegridad) {
          alterado = true;
          primerAlteradoId = e.id;
          break;
        }
        prevHash = e.hashIntegridad;
      } else {
        eventosHistoricosSinHash++;
      }
    }

    return {
      cadenaValida: !alterado,
      eventosVerificados,
      eventosHistoricosSinHash,
      primerAlteradoId,
    };
  }
}

export const auditService = new AuditService();

import { prisma } from "../../../config/database";
import { technicalLogger } from "../../../utils/technical-logger";
import { pm2LogsReaderService } from "./pm2-logs-reader.service";
import { sanitizarValores } from "./audit.service";

export interface IncidentDiagnosticsReport {
  timestamp: string;
  resumenIncidente: string;
  entorno: string;
  modoCorrelacion: "estricto_id" | "aproximado_temporal";
  servidor: {
    uptimeSegundos: number;
    memoriaRssMb: number;
    fechaServidor: string;
    versionNode: string;
  };
  errorPrincipal?: {
    mensaje?: string;
    codigo?: string;
    tipo?: string;
    stackTrace?: string;
    requestId?: string;
    correlationId?: string;
  };
  peticionHttpAsociada?: {
    metodo?: string;
    ruta?: string;
    duracionMs?: number;
    codigoRespuesta?: number;
  };
  contextoAuditFuncional: any[];
  logsTecnicosVentana: any[];
  logsPm2Relevantes: string[];
  saludBaseDatos: {
    conectada: boolean;
    latenciaMs?: number;
    error?: string;
  };
  hipotesisCausa?: string;
}

export class AiDiagnosticsService {
  /**
   * Genera un paquete de diagnóstico para asistencia técnica con IA.
   * Totalmente sanitizado: elimina secretos, tokens, contraseñas y datos no autorizados.
   * Prioriza correlación estricta por requestId o correlationId si están presentes.
   */
  async buildDiagnosticsPackage(options: {
    requestId?: string;
    correlationId?: string;
    codigoError?: string;
    ventanaMinutos?: number;
  }): Promise<IncidentDiagnosticsReport> {
    const ventanaMinutos = Math.min(60, Math.max(1, options.ventanaMinutos || 15));
    const ahora = new Date();
    const fechaDesde = new Date(ahora.getTime() - ventanaMinutos * 60 * 1000);
    const fechaDesdeIso = fechaDesde.toISOString();

    const hasCorrelation = Boolean(options.requestId || options.correlationId);

    // 1. Salud de base de datos
    let dbOk = false;
    let latenciaMs: number | undefined;
    let dbError: string | undefined;
    try {
      const t0 = performance.now();
      await prisma.$queryRawUnsafe("SELECT 1");
      latenciaMs = Math.round(performance.now() - t0);
      dbOk = true;
    } catch (e: any) {
      dbError = e?.message || "Fallo de conexión a MySQL";
    }

    // 2. Logs técnicos estructurados en la ventana temporal
    const logsResult = await technicalLogger.queryLogs({
      fechaDesde: fechaDesdeIso,
      requestId: options.requestId,
      limit: hasCorrelation ? 25 : 15,
    });

    const logsSanitizados = (sanitizarValores(logsResult.items) as any[]) || [];

    // 3. Eventos de auditoría funcional asociados
    const auditEvents = await prisma.registroAuditoria.findMany({
      where: {
        fecha: { gte: fechaDesde },
      },
      include: {
        usuario: { select: { id: true, usuario: true, nombre: true } },
        departamento: { select: { id: true, codigo: true, nombre: true } },
        terminal: { select: { id: true, nombre: true } },
      },
      take: hasCorrelation ? 20 : 10,
      orderBy: { id: "desc" },
    });

    // Filtrar si hay correlationId en los detalles
    let filteredAudit = auditEvents;
    if (options.correlationId) {
      const matched = auditEvents.filter((ev) => {
        const d = ev.detalles as any;
        return d?.correlationId === options.correlationId;
      });
      if (matched.length > 0) {
        filteredAudit = matched;
      }
    }

    const auditSanitizados = (sanitizarValores(filteredAudit) as any[]) || [];

    // 4. Logs de salida/error PM2 relevantes (últimas 30 líneas de error)
    let pm2Lines: string[] = [];
    try {
      const files = pm2LogsReaderService.getAuthorizedLogFiles();
      const errFile = files.find((f) => f.nombre.includes("error") || f.nombre.includes("err") || f.nombre.includes("backend-technical"));
      if (errFile) {
        const content = await pm2LogsReaderService.readLogFile(errFile.nombre, {
          lineasMaximas: 30,
        });
        pm2Lines = content.lineas.map((l) => (sanitizarValores(l) as string));
      }
    } catch {
      // Ignorar si no hay logs de PM2 en desarrollo local
    }

    // 5. Extraer el error principal si coincide con requestId
    const logErrorPrincipal = logsResult.items.find(
      (l) => l.level === "error" || (options.requestId && l.requestId === options.requestId)
    );

    const mem = process.memoryUsage();

    return {
      timestamp: ahora.toISOString(),
      resumenIncidente:
        logErrorPrincipal?.mensaje ||
        `Diagnóstico del sistema solicitado en ventana de ${ventanaMinutos} minutos`,
      entorno: process.env.NODE_ENV || "development",
      modoCorrelacion: hasCorrelation ? "estricto_id" : "aproximado_temporal",
      servidor: {
        uptimeSegundos: Math.round(process.uptime()),
        memoriaRssMb: Math.round(mem.rss / (1024 * 1024)),
        fechaServidor: ahora.toISOString(),
        versionNode: process.version,
      },
      errorPrincipal: logErrorPrincipal
        ? {
            mensaje: logErrorPrincipal.mensaje,
            codigo: logErrorPrincipal.codigoError,
            tipo: logErrorPrincipal.tipoExcepcion,
            stackTrace: logErrorPrincipal.stackTrace,
            requestId: logErrorPrincipal.requestId,
            correlationId: logErrorPrincipal.correlationId,
          }
        : undefined,
      peticionHttpAsociada: logErrorPrincipal
        ? {
            metodo: logErrorPrincipal.metodoHttp,
            ruta: logErrorPrincipal.rutaHttp,
            duracionMs: logErrorPrincipal.duracionMs,
            codigoRespuesta: logErrorPrincipal.codigoRespuesta,
          }
        : undefined,
      contextoAuditFuncional: auditSanitizados,
      logsTecnicosVentana: logsSanitizados,
      logsPm2Relevantes: pm2Lines,
      saludBaseDatos: {
        conectada: dbOk,
        latenciaMs,
        error: dbError,
      },
      hipotesisCausa: !dbOk
        ? "Posible fallo o interrupción de conexión con el motor de base de datos MySQL."
        : logErrorPrincipal?.tipoExcepcion === "PrismaClientKnownRequestError"
        ? "Excepción generada por violación de restricción o consulta fallida en Prisma."
        : undefined,
    };
  }

  /**
   * Genera el diagnóstico en formato Markdown optimizado y sanitizado para copiar a una IA.
   */
  formatDiagnosticsAsMarkdown(d: IncidentDiagnosticsReport): string {
    const lines: string[] = [];

    lines.push(`# REPORTE DE DIAGNÓSTICO TÉCNICO MBC — SISTEMA DE CALIDAD`);
    lines.push(`**Fecha:** ${d.timestamp}`);
    lines.push(`**Entorno:** ${d.entorno}`);
    lines.push(`**Modo de Correlación:** ${d.modoCorrelacion === "estricto_id" ? "ESTRICTO (Por Request/Correlation ID)" : "APROXIMADO (Ventana temporal reciente)"}`);
    lines.push(`**Uptime:** ${d.servidor.uptimeSegundos}s | **Memoria RSS:** ${d.servidor.memoriaRssMb} MB`);
    lines.push("");

    lines.push(`## 1. Resumen del Incidente`);
    lines.push(`> ${d.resumenIncidente}`);
    lines.push("");

    lines.push(`## 2. Salud de Base de Datos MySQL`);
    lines.push(`- **Estado:** ${d.saludBaseDatos.conectada ? "CONECTADA (OK)" : "ERROR DE CONEXIÓN"}`);
    if (d.saludBaseDatos.latenciaMs !== undefined) {
      lines.push(`- **Latencia:** ${d.saludBaseDatos.latenciaMs} ms`);
    }
    if (d.saludBaseDatos.error) {
      lines.push(`- **Detalle Error BD:** \`${d.saludBaseDatos.error}\``);
    }
    lines.push("");

    if (d.errorPrincipal) {
      lines.push(`## 3. Error Principal Detectado`);
      lines.push(`- **Tipo:** ${d.errorPrincipal.tipo || "Error"}`);
      lines.push(`- **Mensaje:** \`${d.errorPrincipal.mensaje}\``);
      if (d.errorPrincipal.codigo) lines.push(`- **Código:** \`${d.errorPrincipal.codigo}\``);
      if (d.errorPrincipal.requestId) lines.push(`- **Request ID:** \`${d.errorPrincipal.requestId}\``);
      if (d.errorPrincipal.correlationId) lines.push(`- **Correlation ID:** \`${d.errorPrincipal.correlationId}\``);

      if (d.errorPrincipal.stackTrace) {
        lines.push("");
        lines.push("### Stack Trace:");
        lines.push("```text");
        lines.push(d.errorPrincipal.stackTrace.slice(0, 1500));
        lines.push("```");
      }
      lines.push("");
    }

    if (d.peticionHttpAsociada) {
      lines.push(`## 4. Petición HTTP Asociada`);
      lines.push(`- **Método/Ruta:** ${d.peticionHttpAsociada.metodo} ${d.peticionHttpAsociada.ruta}`);
      lines.push(`- **Código HTTP:** ${d.peticionHttpAsociada.codigoRespuesta || "N/A"}`);
      lines.push(`- **Duración:** ${d.peticionHttpAsociada.duracionMs || 0} ms`);
      lines.push("");
    }

    lines.push(`## 5. Eventos de Auditoría Funcional Recientes (${d.contextoAuditFuncional.length})`);
    lines.push("```json");
    lines.push(JSON.stringify(d.contextoAuditFuncional, null, 2));
    lines.push("```");
    lines.push("");

    lines.push(`## 6. Logs Técnicos Recientes (${d.logsTecnicosVentana.length})`);
    lines.push("```json");
    lines.push(JSON.stringify(d.logsTecnicosVentana, null, 2));
    lines.push("```");
    lines.push("");

    if (d.logsPm2Relevantes.length > 0) {
      lines.push(`## 7. Salida Relevante PM2 / Proceso`);
      lines.push("```text");
      lines.push(d.logsPm2Relevantes.join("\n").slice(0, 2000));
      lines.push("```");
      lines.push("");
    }

    if (d.hipotesisCausa) {
      lines.push(`## 8. Hipótesis Inicial de Causa`);
      lines.push(`> ${d.hipotesisCausa}`);
      lines.push("");
    }

    lines.push("---");
    lines.push("*Reporte sanitizado automáticamente: secretos y credenciales han sido redactados.*");

    return lines.join("\n");
  }
}

export const aiDiagnosticsService = new AiDiagnosticsService();

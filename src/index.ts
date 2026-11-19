import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./utils/logger";
import { prisma } from "./config/database";
import { legacySyncSchedulerService } from "./modules/inspecciones/services/legacy-sync-scheduler.service";
import { lotesSyncSchedulerService } from "./modules/lotes/services/lotes-sync-scheduler.service";
import type { Server } from "node:http";

let server: Server | null = null;
let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Señal ${signal} recibida. Cerrando servidor y scheduler de forma ordenada...`);

  const forceTimeout = setTimeout(() => {
    logger.error("No se pudo cerrar ordenadamente a tiempo, forzando salida.");
    process.exit(1);
  }, 8000);

  try {
    // 1. Dejar de aceptar nuevas ejecuciones de los schedulers, detener los cron y esperar (hasta 5000ms)
    //    a que cualquier sincronización activa en este proceso termine o registre interrupción limpia
    await Promise.all([
      legacySyncSchedulerService.gracefulShutdown(5000),
      lotesSyncSchedulerService.gracefulShutdown(5000),
    ]);
  } catch (err) {
    logger.error({ err }, "Error durante el apagado ordenado de los schedulers");
  }

  // 2. Cerrar el servidor HTTP de Express y desconectar Prisma
  if (server) {
    server.close(async () => {
      logger.info("Servidor HTTP cerrado (no se aceptan nuevas conexiones).");
      try {
        await prisma.$disconnect();
        logger.info("Conexión a base de datos cerrada ordenadamente.");
        clearTimeout(forceTimeout);
        process.exit(0);
      } catch (err) {
        logger.error({ err }, "Error cerrando la conexión con la base de datos");
        clearTimeout(forceTimeout);
        process.exit(1);
      }
    });
  } else {
    try {
      await prisma.$disconnect();
    } catch {
      // Ignorar si ya estaba desconectado
    }
    clearTimeout(forceTimeout);
    process.exit(0);
  }
};

// Captura de señales estándar de terminación
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Soporte para shutdown_with_message de PM2 (comunicación IPC / process.on('message'))
process.on("message", (msg) => {
  if (msg === "shutdown") {
    shutdown("PM2_SHUTDOWN_MSG");
  }
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Excepción no capturada (uncaughtException)");
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "Promesa rechazada no capturada (unhandledRejection)");
  shutdown("unhandledRejection");
});

async function startServer() {
  try {
    // 1. Verificar conectividad a base de datos antes de aceptar tráfico
    await prisma.$queryRaw`SELECT 1`;
    logger.info("Conexión inicial con la base de datos MySQL establecida correctamente.");

    // Limpieza preventiva no destructiva de asignaciones departamentales residuales en usuarios con rol administrativo
    await prisma.usuarioDepartamento
      .deleteMany({
        where: {
          usuario: {
            rol: {
              codigo: { in: ["SUPER_ADMIN", "ADMIN", "VISUALIZADOR"] },
            },
          },
        },
      })
      .catch((err) => {
        logger.warn({ err }, "No se pudo completar la limpieza preventiva de asignaciones residuales");
      });

    // 2. Crear app Express y enlazar puerto
    const app = createApp();

    server = app.listen(env.PORT, env.SERVER_HOST, () => {
      logger.info(
        `🚀 Servidor ejecutándose en http://${env.SERVER_HOST}:${env.PORT} [${env.NODE_ENV}]`
      );
      logger.info(`👉 Health check disponible en: http://${env.SERVER_HOST}:${env.PORT}/health`);

      // 3. Inicializar los schedulers (Legacy 05:00/20:00 y Lotes 06:00 America/Mexico_City)
      //    y lanzar la recuperación controlada de sincronizaciones pendientes en segundo plano
      legacySyncSchedulerService
        .initializeBackendScheduler({
          runRecoveryOnStart: true,
          awaitRecovery: false,
        })
        .catch((err) => {
          logger.error(
            { err },
            "Error al inicializar el scheduler integrado de sincronización Legacy"
          );
        });

      lotesSyncSchedulerService
        .initializeBackendScheduler({
          runRecoveryOnStart: true,
          awaitRecovery: false,
        })
        .catch((err) => {
          logger.error(
            { err },
            "Error al inicializar el scheduler integrado de sincronización de Lotes"
          );
        });
    });
  } catch (error) {
    logger.fatal(
      { error },
      "❌ Fallo crítico al iniciar el servidor (verifique conexión a base de datos y configuración)"
    );
    try {
      await prisma.$disconnect();
    } catch {
      // Sin acción
    }
    process.exit(1);
  }
}

startServer();

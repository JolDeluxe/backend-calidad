import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./utils/logger";
import { prisma } from "./config/database";

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`🚀 Servidor ejecutándose en el puerto ${env.PORT} [${env.NODE_ENV}]`);
  logger.info(`👉 Health check disponible en: http://localhost:${env.PORT}/health`);
});

const shutdown = async (signal: string) => {
  logger.info(`Señal ${signal} recibida. Cerrando servidor de forma ordenada...`);

  server.close(async () => {
    logger.info("Servidor HTTP cerrado.");
    try {
      await prisma.$disconnect();
      logger.info("Conexión a Prisma/Base de datos cerrada.");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error cerrando la base de datos");
      process.exit(1);
    }
  });

  setTimeout(() => {
    logger.error("No se pudo cerrar ordenadamente a tiempo, forzando salida.");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
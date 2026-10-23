import { PrismaClient } from '@prisma/client';
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { env } from "./env";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const normalizeMariaDbUrl = (url: string): string => {
  let normalized = url.replace(/^mysql:\/\//i, "mariadb://");
  if (!normalized.includes("allowPublicKeyRetrieval")) {
    normalized += (normalized.includes("?") ? "&" : "?") + "allowPublicKeyRetrieval=true";
  }
  return normalized;
};

const createPrismaClient = (): PrismaClient => {
  const adapter = new PrismaMariaDb(normalizeMariaDbUrl(env.DATABASE_URL));
  return new PrismaClient({ adapter });
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
import { PrismaClient } from '@prisma/client';

let client: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient();
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  await client?.$disconnect();
  client = null;
}

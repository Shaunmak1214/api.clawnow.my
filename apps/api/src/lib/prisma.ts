import { PrismaClient } from '@prisma/client'

declare global {
  // eslint-disable-next-line no-var
  var __clawnowPrisma__: PrismaClient | undefined
}

export const prisma =
  globalThis.__clawnowPrisma__ ??
  new PrismaClient({
    log: ['warn', 'error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalThis.__clawnowPrisma__ = prisma
}

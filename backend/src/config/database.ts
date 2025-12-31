import { PrismaClient } from '@prisma/client';

// Global prisma instance for services that need it outside of Fastify context
// Note: For route handlers, prefer using app.prisma from the Fastify plugin
export const prisma = new PrismaClient();

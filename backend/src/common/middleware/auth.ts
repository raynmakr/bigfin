import type { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../errors/app-error.js';

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();

    // Attach decoded token to request
    const decoded = request.user as { sub: string; tenantId: string; role: string };
    request.user = decoded;
  } catch (err) {
    throw AppError.unauthorized('Invalid or expired token');
  }
}

export async function requireRole(...roles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await authenticate(request, reply);

    if (!roles.includes(request.user.role)) {
      throw AppError.forbidden('Insufficient permissions');
    }
  };
}

export async function optionalAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
    const decoded = request.user as { sub: string; tenantId: string; role: string };
    request.user = decoded;
  } catch {
    // Auth is optional, continue without user
  }
}

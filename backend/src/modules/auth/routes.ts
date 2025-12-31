import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { AppError } from '../../common/errors/app-error.js';

const tokenRequestSchema = z.object({
  grant_type: z.enum(['password', 'refresh_token']),
  email: z.string().email().optional(),
  password: z.string().optional(),
  refresh_token: z.string().optional(),
});

export async function authRoutes(app: FastifyInstance) {
  // POST /auth/token - Get access token
  app.post('/token', {
    schema: {
      description: 'Exchange credentials for JWT access token',
      tags: ['Auth'],
      body: {
        type: 'object',
        properties: {
          grant_type: { type: 'string', enum: ['password', 'refresh_token'] },
          email: { type: 'string', format: 'email' },
          password: { type: 'string' },
          refresh_token: { type: 'string' },
        },
        required: ['grant_type'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            access_token: { type: 'string' },
            token_type: { type: 'string' },
            expires_in: { type: 'number' },
            refresh_token: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const body = tokenRequestSchema.parse(request.body);

    if (body.grant_type === 'password') {
      if (!body.email || !body.password) {
        throw AppError.invalidRequest('Email and password required for password grant');
      }

      const user = await app.prisma.user.findFirst({
        where: { email: body.email },
        include: { tenant: true },
      });

      if (!user) {
        throw AppError.unauthorized('Invalid credentials');
      }

      const validPassword = await bcrypt.compare(body.password, user.passwordHash);
      if (!validPassword) {
        throw AppError.unauthorized('Invalid credentials');
      }

      const accessToken = app.jwt.sign({
        sub: user.id,
        tenantId: user.tenantId,
        role: user.role,
      });

      const refreshToken = app.jwt.sign(
        { sub: user.id, type: 'refresh' },
        { expiresIn: '7d' }
      );

      // Update last login
      await app.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refreshToken,
      };
    }

    if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) {
        throw AppError.invalidRequest('Refresh token required');
      }

      try {
        const decoded = app.jwt.verify<{ sub: string; type: string }>(body.refresh_token);

        if (decoded.type !== 'refresh') {
          throw AppError.unauthorized('Invalid refresh token');
        }

        const user = await app.prisma.user.findUnique({
          where: { id: decoded.sub },
        });

        if (!user || user.status !== 'ACTIVE') {
          throw AppError.unauthorized('User not found or inactive');
        }

        const accessToken = app.jwt.sign({
          sub: user.id,
          tenantId: user.tenantId,
          role: user.role,
        });

        const refreshToken = app.jwt.sign(
          { sub: user.id, type: 'refresh' },
          { expiresIn: '7d' }
        );

        return {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: refreshToken,
        };
      } catch {
        throw AppError.unauthorized('Invalid refresh token');
      }
    }

    throw AppError.invalidRequest('Unsupported grant type');
  });
}

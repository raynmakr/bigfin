import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { env, isDev } from './config/env.js';
import { prismaPlugin } from './common/plugins/prisma.js';
import { errorHandler } from './common/middleware/error-handler.js';
import { requestLogger } from './common/middleware/request-logger.js';

// Module routes
import { authRoutes } from './modules/auth/routes.js';
import { customerRoutes } from './modules/customers/routes.js';
import { fundingRoutes } from './modules/funding/routes.js';
import { prefundRoutes } from './modules/prefund/routes.js';
import { loanOfferRoutes } from './modules/loans/offer.routes.js';
import { loanContractRoutes } from './modules/loans/contract.routes.js';
import { disbursementRoutes } from './modules/payments/disbursement.routes.js';
import { repaymentRoutes } from './modules/payments/repayment.routes.js';
import { paymentRoutes } from './modules/payments/routes.js';
import { ledgerRoutes } from './modules/ledger/routes.js';
import { documentRoutes } from './modules/documents/routes.js';
import { webhookRoutes } from './modules/webhooks/routes.js';
import { operatorRoutes } from './modules/operator/routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport: isDev
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
    },
    trustProxy: true,
  });

  // ============================================================
  // Core Plugins
  // ============================================================

  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: false, // API doesn't serve HTML
  });

  // CORS
  await app.register(cors, {
    origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(','),
    credentials: true,
  });

  // Sensible defaults (httpErrors, etc.)
  await app.register(sensible);

  // Rate limiting
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      // Rate limit by tenant + IP
      const tenantId = req.headers['x-tenant-id'] as string;
      return tenantId ? `${tenantId}:${req.ip}` : req.ip;
    },
  });

  // JWT authentication
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: {
      expiresIn: env.JWT_EXPIRES_IN,
    },
  });

  // ============================================================
  // Documentation
  // ============================================================

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'BigFin API',
        version: '0.1.0',
        description: 'Multi-tenant loan administration API',
      },
      servers: [
        { url: `http://localhost:${env.PORT}`, description: 'Local' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // ============================================================
  // Custom Plugins
  // ============================================================

  // Database
  await app.register(prismaPlugin);

  // Request logging
  await app.register(requestLogger);

  // Error handling
  app.setErrorHandler(errorHandler);

  // ============================================================
  // Routes
  // ============================================================

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // API routes (v1)
  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(customerRoutes, { prefix: '/customers' });
      await api.register(fundingRoutes, { prefix: '/funding-instruments' });
      await api.register(prefundRoutes, { prefix: '/customers' });
      await api.register(loanOfferRoutes, { prefix: '/loan-offers' });
      await api.register(loanContractRoutes, { prefix: '/loan-contracts' });
      await api.register(disbursementRoutes, { prefix: '/disbursements' });
      await api.register(repaymentRoutes, { prefix: '/repayments' });
      await api.register(paymentRoutes, { prefix: '/payments' });
      await api.register(ledgerRoutes, { prefix: '/ledger' });
      await api.register(documentRoutes, { prefix: '/documents' });
      await api.register(webhookRoutes, { prefix: '/webhooks' });
      await api.register(operatorRoutes, { prefix: '/operator' });
    },
    { prefix: '/v1' }
  );

  return app;
}

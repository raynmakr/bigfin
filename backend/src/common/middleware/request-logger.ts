import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

async function requestLoggerPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    request.log.info({
      method: request.method,
      url: request.url,
      tenantId: request.headers['x-tenant-id'],
    }, 'Incoming request');
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
    }, 'Request completed');
  });
}

export const requestLogger = fp(requestLoggerPlugin, {
  name: 'request-logger',
});

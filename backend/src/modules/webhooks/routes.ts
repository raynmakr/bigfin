import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { AppError } from '../../common/errors/app-error.js';
import { authenticate } from '../../common/middleware/auth.js';

const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
  secret: z.string().optional(),
});

export async function webhookRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);

  // POST /webhooks - Register webhook
  app.post('/', {
    schema: {
      description: 'Register webhook endpoint',
      tags: ['Webhooks'],
    },
  }, async (request, reply) => {
    const body = createWebhookSchema.parse(request.body);
    const tenantId = request.user.tenantId;

    const secret = body.secret ?? `whsec_${nanoid(32)}`;

    const webhook = await app.prisma.webhook.create({
      data: {
        tenantId,
        url: body.url,
        events: body.events,
        secret,
      },
    });

    reply.status(201);
    return {
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      secret, // Only returned on creation
      status: webhook.status.toLowerCase(),
      created_at: webhook.createdAt.toISOString(),
    };
  });

  // GET /webhooks - List webhooks
  app.get('/', {
    schema: {
      description: 'List webhook endpoints',
      tags: ['Webhooks'],
    },
  }, async (request) => {
    const webhooks = await app.prisma.webhook.findMany({
      where: { tenantId: request.user.tenantId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      data: webhooks.map((w) => ({
        id: w.id,
        url: w.url,
        events: w.events,
        status: w.status.toLowerCase(),
        created_at: w.createdAt.toISOString(),
      })),
    };
  });

  // DELETE /webhooks/:webhook_id
  app.delete('/:webhook_id', {
    schema: {
      description: 'Delete webhook endpoint',
      tags: ['Webhooks'],
    },
  }, async (request, reply) => {
    const { webhook_id } = request.params as { webhook_id: string };

    const webhook = await app.prisma.webhook.findFirst({
      where: { id: webhook_id, tenantId: request.user.tenantId },
    });

    if (!webhook) {
      throw AppError.notFound('Webhook');
    }

    await app.prisma.webhook.delete({
      where: { id: webhook_id },
    });

    reply.status(204);
  });
}

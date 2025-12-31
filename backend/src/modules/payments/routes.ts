import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { authenticate } from '../../common/middleware/auth.js';
import { getTransferService } from './services/transfer-service.js';
import { getRoutingService } from './services/routing-service.js';
import { getMoovWebhookHandler } from './services/webhook-handler.js';
import type { PaymentSpeed, PaymentDirection, InstrumentCapabilities } from './types.js';

const initiateTransferSchema = z.object({
  contract_id: z.string().uuid().optional(),
  source_account_id: z.string().uuid(),
  destination_account_id: z.string().uuid(),
  amount_cents: z.number().int().positive(),
  speed: z.enum(['standard', 'instant']),
  direction: z.enum(['credit', 'debit']),
  description: z.string().min(1).max(255),
  metadata: z.record(z.string()).optional(),
  idempotency_key: z.string().optional(),
});

const getRoutingOptionsSchema = z.object({
  source_account_id: z.string().uuid(),
  destination_account_id: z.string().uuid().optional(),
  amount_cents: z.number().int().positive(),
  direction: z.enum(['credit', 'debit']),
});

export async function paymentRoutes(app: FastifyInstance) {
  const transferService = getTransferService();
  const routingService = getRoutingService();
  const webhookHandler = getMoovWebhookHandler();

  // ============================================================================
  // Authenticated endpoints
  // ============================================================================

  // POST /payments/transfers - Initiate a transfer
  app.post('/transfers', {
    onRequest: [authenticate],
    schema: {
      description: 'Initiate a payment transfer',
      tags: ['Payments'],
    },
  }, async (request, reply) => {
    const body = initiateTransferSchema.parse(request.body);
    const tenantId = request.user.tenantId;

    const result = await transferService.initiateTransfer(tenantId, {
      contractId: body.contract_id,
      sourceAccountId: body.source_account_id,
      destinationAccountId: body.destination_account_id,
      amountCents: body.amount_cents,
      speed: body.speed as PaymentSpeed,
      direction: body.direction as PaymentDirection,
      description: body.description,
      metadata: body.metadata,
      idempotencyKey: body.idempotency_key,
    });

    reply.status(201);
    return {
      id: result.id,
      provider_transfer_id: result.providerTransferId,
      rail: result.rail,
      status: result.status,
      amount_cents: result.amountCents,
      fee_cents: result.feeCents,
      estimated_arrival: result.estimatedArrival.toISOString(),
      initiated_at: result.initiatedAt.toISOString(),
      completed_at: result.completedAt?.toISOString(),
      failure_reason: result.failureReason,
    };
  });

  // GET /payments/transfers/:transfer_id - Get transfer status
  app.get('/transfers/:transfer_id', {
    onRequest: [authenticate],
    schema: {
      description: 'Get transfer status',
      tags: ['Payments'],
    },
  }, async (request) => {
    const { transfer_id } = request.params as { transfer_id: string };
    const tenantId = request.user.tenantId;

    const result = await transferService.getTransfer(tenantId, transfer_id);

    if (!result) {
      throw AppError.notFound('Transfer');
    }

    return {
      id: result.id,
      provider_transfer_id: result.providerTransferId,
      rail: result.rail,
      status: result.status,
      amount_cents: result.amountCents,
      fee_cents: result.feeCents,
      estimated_arrival: result.estimatedArrival.toISOString(),
      initiated_at: result.initiatedAt.toISOString(),
      completed_at: result.completedAt?.toISOString(),
      failure_reason: result.failureReason,
    };
  });

  // POST /payments/transfers/:transfer_id/cancel - Cancel a pending transfer
  app.post('/transfers/:transfer_id/cancel', {
    onRequest: [authenticate],
    schema: {
      description: 'Cancel a pending transfer',
      tags: ['Payments'],
    },
  }, async (request, reply) => {
    const { transfer_id } = request.params as { transfer_id: string };
    const tenantId = request.user.tenantId;

    await transferService.cancelTransfer(tenantId, transfer_id);

    reply.status(204);
  });

  // POST /payments/routing/options - Get routing options for a transfer
  app.post('/routing/options', {
    onRequest: [authenticate],
    schema: {
      description: 'Get available routing options (standard vs instant)',
      tags: ['Payments'],
    },
  }, async (request) => {
    const body = getRoutingOptionsSchema.parse(request.body);
    const tenantId = request.user.tenantId;

    // Get instrument capabilities
    const sourceInstrument = await getInstrumentCapabilities(
      app,
      tenantId,
      body.source_account_id
    );

    let destInstrument: InstrumentCapabilities | undefined;
    if (body.destination_account_id) {
      destInstrument = await getInstrumentCapabilities(
        app,
        tenantId,
        body.destination_account_id
      );
    }

    const options = await routingService.getRoutingOptions({
      direction: body.direction as PaymentDirection,
      amountCents: body.amount_cents,
      sourceInstrument,
      destinationInstrument: destInstrument,
    });

    return {
      standard: {
        rail: options.standard.rail,
        estimated_arrival: options.standard.estimatedArrival.toISOString(),
        fee_cents: options.standard.fee,
        reason: options.standard.reason,
      },
      instant: options.instant ? {
        rail: options.instant.rail,
        estimated_arrival: options.instant.estimatedArrival.toISOString(),
        fee_cents: options.instant.fee,
        reason: options.instant.reason,
        fallback_rails: options.instant.fallbackRails,
      } : null,
      instant_available: options.instantAvailable,
    };
  });

  // POST /payments/routing/fee - Calculate express fee for an amount
  app.post('/routing/fee', {
    onRequest: [authenticate],
    schema: {
      description: 'Calculate express disbursement fee',
      tags: ['Payments'],
    },
  }, async (request) => {
    const body = z.object({
      amount_cents: z.number().int().positive(),
      speed: z.enum(['standard', 'instant']),
    }).parse(request.body);

    const fee = routingService.calculateFee(
      body.speed as PaymentSpeed,
      body.amount_cents
    );

    return {
      amount_cents: body.amount_cents,
      speed: body.speed,
      fee_cents: fee,
    };
  });

  // POST /payments/routing/prefund-waiver - Check if prefund waives express fee
  app.post('/routing/prefund-waiver', {
    onRequest: [authenticate],
    schema: {
      description: 'Check if lender prefund balance waives express fee',
      tags: ['Payments'],
    },
  }, async (request) => {
    const body = z.object({
      lender_id: z.string().uuid(),
      principal_cents: z.number().int().positive(),
    }).parse(request.body);

    const tenantId = request.user.tenantId;

    const result = await routingService.checkPrefundWaiver(
      tenantId,
      body.lender_id,
      body.principal_cents
    );

    return {
      waived: result.waived,
      reason: result.reason,
    };
  });

  // ============================================================================
  // Moov webhook endpoint (no auth - signature verified)
  // ============================================================================

  // POST /payments/webhooks/moov - Receive Moov webhooks
  app.post('/webhooks/moov', {
    schema: {
      description: 'Moov webhook receiver',
      tags: ['Payments', 'Webhooks'],
    },
    config: {
      rawBody: true, // Need raw body for signature verification
    },
  }, async (request, reply) => {
    const rawBody = (request as any).rawBody as string;
    const signature = request.headers['moov-signature'] as string;
    const timestamp = request.headers['moov-timestamp'] as string;

    // Verify signature
    if (signature && timestamp) {
      const isValid = webhookHandler.verifySignature(rawBody, signature, timestamp);
      if (!isValid) {
        throw AppError.invalidRequest('Invalid webhook signature');
      }
    }

    // Parse and process event
    const event = webhookHandler.parseEvent(rawBody || JSON.stringify(request.body));
    await webhookHandler.processEvent(event);

    // Acknowledge receipt
    reply.status(200);
    return { received: true };
  });
}

// Helper to get instrument capabilities
async function getInstrumentCapabilities(
  app: FastifyInstance,
  tenantId: string,
  instrumentId: string
): Promise<InstrumentCapabilities> {
  const instrument = await app.prisma.fundingInstrument.findFirst({
    where: {
      id: instrumentId,
      customer: { tenantId },
    },
  });

  if (!instrument) {
    throw AppError.notFound('Funding instrument');
  }

  const isVerified = instrument.status === 'VERIFIED';

  // Default rails by instrument type
  let supportedRails: string[] = [];
  if (instrument.type === 'BANK_ACCOUNT') {
    supportedRails = isVerified
      ? ['rtp', 'fednow', 'same_day_ach', 'ach']
      : ['ach'];
  } else if (instrument.type === 'DEBIT_CARD') {
    supportedRails = ['push_to_card'];
  }

  return {
    id: instrumentId,
    type: instrument.type === 'BANK_ACCOUNT' ? 'bank_account' : 'debit_card',
    supportedRails: supportedRails as any,
    verified: isVerified,
  };
}

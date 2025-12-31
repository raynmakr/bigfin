import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { authenticate } from '../../common/middleware/auth.js';

const createInstrumentSchema = z.object({
  type: z.enum(['BANK_ACCOUNT', 'DEBIT_CARD']),
  plaid_token: z.string().optional(),
  routing_number: z.string().optional(),
  account_number: z.string().optional(),
  account_type: z.enum(['CHECKING', 'SAVINGS']).optional(),
  card_token: z.string().optional(),
  is_default: z.boolean().default(false),
});

export async function fundingRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);

  // GET /funding-instruments/:instrument_id
  app.get('/:instrument_id', {
    schema: {
      description: 'Get funding instrument details',
      tags: ['Funding Instruments'],
    },
  }, async (request) => {
    const { instrument_id } = request.params as { instrument_id: string };

    const instrument = await app.prisma.fundingInstrument.findUnique({
      where: { id: instrument_id },
      include: { customer: true },
    });

    if (!instrument || instrument.customer.tenantId !== request.user.tenantId) {
      throw AppError.notFound('Funding instrument');
    }

    return formatInstrument(instrument);
  });

  // DELETE /funding-instruments/:instrument_id
  app.delete('/:instrument_id', {
    schema: {
      description: 'Remove funding instrument',
      tags: ['Funding Instruments'],
    },
  }, async (request, reply) => {
    const { instrument_id } = request.params as { instrument_id: string };

    const instrument = await app.prisma.fundingInstrument.findUnique({
      where: { id: instrument_id },
      include: { customer: true },
    });

    if (!instrument || instrument.customer.tenantId !== request.user.tenantId) {
      throw AppError.notFound('Funding instrument');
    }

    await app.prisma.fundingInstrument.update({
      where: { id: instrument_id },
      data: { status: 'REMOVED' },
    });

    reply.status(204);
  });

  // POST /funding-instruments/:instrument_id/verify
  app.post('/:instrument_id/verify', {
    schema: {
      description: 'Verify funding instrument with micro-deposits',
      tags: ['Funding Instruments'],
    },
  }, async (request) => {
    const { instrument_id } = request.params as { instrument_id: string };
    const { amounts_cents } = request.body as { amounts_cents: number[] };

    const instrument = await app.prisma.fundingInstrument.findUnique({
      where: { id: instrument_id },
      include: { customer: true },
    });

    if (!instrument || instrument.customer.tenantId !== request.user.tenantId) {
      throw AppError.notFound('Funding instrument');
    }

    // TODO: Verify with Moov
    // For now, simulate verification
    const updated = await app.prisma.fundingInstrument.update({
      where: { id: instrument_id },
      data: {
        status: 'VERIFIED',
        verifiedAt: new Date(),
        verificationMethod: 'micro_deposit',
      },
    });

    return formatInstrument(updated);
  });
}

function formatInstrument(instrument: {
  id: string;
  customerId: string;
  type: string;
  status: string;
  bankName: string | null;
  accountType: string | null;
  last4: string;
  supportedRails: string[];
  isDefault: boolean;
  createdAt: Date;
}) {
  return {
    id: instrument.id,
    customer_id: instrument.customerId,
    type: instrument.type.toLowerCase(),
    status: instrument.status.toLowerCase(),
    bank_name: instrument.bankName,
    account_type: instrument.accountType?.toLowerCase(),
    last4: instrument.last4,
    supported_rails: instrument.supportedRails.map((r) => r.toLowerCase()),
    is_default: instrument.isDefault,
    created_at: instrument.createdAt.toISOString(),
  };
}

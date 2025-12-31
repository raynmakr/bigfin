import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { authenticate } from '../../common/middleware/auth.js';
import { getTransferService } from './services/transfer-service.js';
import { getRoutingService } from './services/routing-service.js';
import type { PaymentSpeed } from './types.js';

const disbursementRequestSchema = z.object({
  speed: z.enum(['STANDARD', 'INSTANT']),
  funding_instrument_id: z.string().uuid().optional(),
});

export async function disbursementRoutes(app: FastifyInstance) {
  const transferService = getTransferService();
  const routingService = getRoutingService();

  app.addHook('onRequest', authenticate);

  // POST /loan-contracts/:contract_id/disburse
  app.post('/loan-contracts/:contract_id/disburse', {
    schema: {
      description: 'Initiate disbursement to borrower',
      tags: ['Disbursements'],
    },
  }, async (request, reply) => {
    const { contract_id } = request.params as { contract_id: string };
    const body = disbursementRequestSchema.parse(request.body);
    const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
    const tenantId = request.user.tenantId;

    // Check idempotency
    if (idempotencyKey) {
      const existing = await app.prisma.idempotencyKey.findUnique({
        where: { key: idempotencyKey },
      });
      if (existing && existing.expiresAt > new Date()) {
        reply.status(existing.statusCode);
        return existing.response;
      }
    }

    const contract = await app.prisma.loanContract.findFirst({
      where: { id: contract_id, tenantId },
      include: {
        borrower: {
          include: { fundingInstruments: { where: { status: 'VERIFIED' } } },
        },
        lender: true,
      },
    });

    if (!contract) {
      throw AppError.notFound('Loan contract');
    }

    if (contract.status !== 'PENDING_DISBURSEMENT') {
      throw AppError.invalidState('Contract is not pending disbursement');
    }

    // Get destination funding instrument (borrower's)
    const instrumentId = body.funding_instrument_id
      ?? contract.borrower.fundingInstruments[0]?.id;

    if (!instrumentId) {
      throw AppError.invalidRequest('No verified funding instrument for borrower');
    }

    // Get lender's funding source (prefund account or linked instrument)
    // For now, we'll use the platform's Moov account as source
    // In a full implementation, this would check prefund balance first
    const speed = body.speed.toLowerCase() as PaymentSpeed;

    // Check prefund waiver for instant
    let expressFee = 0;
    let source: 'PREFUND' | 'DIRECT' = 'DIRECT';

    if (speed === 'instant') {
      const waiver = await routingService.checkPrefundWaiver(
        tenantId,
        contract.lenderId,
        contract.principalCents
      );

      if (waiver.waived) {
        source = 'PREFUND';
        expressFee = 0;
      } else {
        expressFee = routingService.calculateFee('instant', contract.principalCents);
      }
    }

    const netAmount = contract.principalCents - expressFee;

    // Create disbursement record
    const disbursement = await app.prisma.disbursement.create({
      data: {
        contractId: contract.id,
        amountCents: contract.principalCents,
        expressFeeCents: expressFee,
        netAmountCents: netAmount,
        speed: body.speed,
        source,
        fundingInstrumentId: instrumentId,
        idempotencyKey,
        status: 'INITIATED',
      },
    });

    try {
      // Initiate transfer via payment service
      const transfer = await transferService.initiateTransfer(tenantId, {
        contractId: contract.id,
        sourceAccountId: contract.lenderId, // Will be resolved to prefund or lender instrument
        destinationAccountId: instrumentId,
        amountCents: netAmount,
        speed,
        direction: 'credit',
        description: `Loan disbursement for contract ${contract.id}`,
        metadata: {
          disbursement_id: disbursement.id,
          contract_id: contract.id,
        },
        idempotencyKey: idempotencyKey ? `${idempotencyKey}-transfer` : undefined,
      });

      // Update disbursement with transfer info
      const updated = await app.prisma.disbursement.update({
        where: { id: disbursement.id },
        data: {
          providerRef: transfer.id,
          rail: transfer.rail.toUpperCase() as any,
          status: 'PENDING',
          availabilityState: 'PENDING',
        },
      });

      // Contract stays in PENDING_DISBURSEMENT until completion
      // (no DISBURSING status in schema)

      const response = formatDisbursement(updated);

      // Store idempotency key
      if (idempotencyKey) {
        await app.prisma.idempotencyKey.create({
          data: {
            key: idempotencyKey,
            response: response as any,
            statusCode: 202,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });
      }

      reply.status(202);
      return response;
    } catch (error) {
      // Update disbursement as failed
      await app.prisma.disbursement.update({
        where: { id: disbursement.id },
        data: {
          status: 'FAILED',
          failureReason: (error as Error).message,
        },
      });

      throw error;
    }
  });

  // GET /disbursements/:disbursement_id
  app.get('/:disbursement_id', {
    schema: {
      description: 'Get disbursement status',
      tags: ['Disbursements'],
    },
  }, async (request) => {
    const { disbursement_id } = request.params as { disbursement_id: string };

    const disbursement = await app.prisma.disbursement.findUnique({
      where: { id: disbursement_id },
      include: { contract: true },
    });

    if (!disbursement || disbursement.contract.tenantId !== request.user.tenantId) {
      throw AppError.notFound('Disbursement');
    }

    return formatDisbursement(disbursement);
  });

  // POST /disbursements/:disbursement_id/cancel
  app.post('/:disbursement_id/cancel', {
    schema: {
      description: 'Cancel pending disbursement',
      tags: ['Disbursements'],
    },
  }, async (request, reply) => {
    const { disbursement_id } = request.params as { disbursement_id: string };
    const tenantId = request.user.tenantId;

    const disbursement = await app.prisma.disbursement.findUnique({
      where: { id: disbursement_id },
      include: { contract: true },
    });

    if (!disbursement || disbursement.contract.tenantId !== tenantId) {
      throw AppError.notFound('Disbursement');
    }

    if (disbursement.status !== 'INITIATED' && disbursement.status !== 'PENDING') {
      throw AppError.invalidState(`Cannot cancel disbursement in ${disbursement.status} status`);
    }

    // Cancel underlying transfer if exists
    if (disbursement.providerRef) {
      try {
        await transferService.cancelTransfer(tenantId, disbursement.providerRef);
      } catch (error) {
        // Transfer may not be cancellable - continue with local cancel
        console.warn(`Could not cancel transfer: ${(error as Error).message}`);
      }
    }

    const updated = await app.prisma.disbursement.update({
      where: { id: disbursement_id },
      data: {
        status: 'FAILED',
        failureReason: 'Cancelled by user',
        failedAt: new Date(),
      },
    });

    return formatDisbursement(updated);
  });
}

function formatDisbursement(disbursement: {
  id: string;
  contractId: string;
  amountCents: number;
  expressFeeCents: number;
  netAmountCents: number;
  speed: string;
  rail: string | null;
  status: string;
  source: string;
  fundingInstrumentId: string;
  availabilityState: string;
  availableAt: Date | null;
  initiatedAt: Date;
  completedAt: Date | null;
  failureReason: string | null;
}) {
  return {
    id: disbursement.id,
    contract_id: disbursement.contractId,
    amount_cents: disbursement.amountCents,
    express_fee_cents: disbursement.expressFeeCents,
    net_amount_cents: disbursement.netAmountCents,
    speed: disbursement.speed.toLowerCase(),
    rail: disbursement.rail?.toLowerCase(),
    status: disbursement.status.toLowerCase(),
    source: disbursement.source.toLowerCase(),
    funding_instrument_id: disbursement.fundingInstrumentId,
    availability: {
      state: disbursement.availabilityState.toLowerCase(),
      available_at: disbursement.availableAt?.toISOString(),
    },
    initiated_at: disbursement.initiatedAt.toISOString(),
    completed_at: disbursement.completedAt?.toISOString(),
    failure_reason: disbursement.failureReason,
  };
}

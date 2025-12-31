import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { authenticate } from '../../common/middleware/auth.js';
import { getTransferService } from './services/transfer-service.js';
import { LedgerService } from '../ledger/service.js';

const repaymentRequestSchema = z.object({
  amount_cents: z.number().int().min(1),
  funding_instrument_id: z.string().uuid().optional(),
  scheduled_date: z.string().optional(),
  is_payoff: z.boolean().optional(),
});

export async function repaymentRoutes(app: FastifyInstance) {
  const transferService = getTransferService();
  const ledgerService = new LedgerService(app.prisma);

  app.addHook('onRequest', authenticate);

  // POST /loan-contracts/:contract_id/repayments
  app.post('/loan-contracts/:contract_id/repayments', {
    schema: {
      description: 'Initiate repayment',
      tags: ['Repayments'],
    },
  }, async (request, reply) => {
    const { contract_id } = request.params as { contract_id: string };
    const body = repaymentRequestSchema.parse(request.body);
    const tenantId = request.user.tenantId;
    const idempotencyKey = request.headers['idempotency-key'] as string | undefined;

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
        lender: {
          include: { fundingInstruments: { where: { status: 'VERIFIED' } } },
        },
      },
    });

    if (!contract) {
      throw AppError.notFound('Loan contract');
    }

    if (contract.status !== 'ACTIVE') {
      throw AppError.invalidState('Contract is not active');
    }

    // Get source funding instrument (borrower's)
    const sourceInstrumentId = body.funding_instrument_id
      ?? contract.borrower.fundingInstruments[0]?.id;

    if (!sourceInstrumentId) {
      throw AppError.invalidRequest('No verified funding instrument for borrower');
    }

    // Get destination funding instrument (lender's or platform account)
    const destInstrumentId = contract.lender.fundingInstruments[0]?.id
      ?? 'platform'; // Fallback to platform account

    // Get current loan balances to determine payment allocation
    const balances = await ledgerService.getLoanBalances(contract.id);

    // Apply payment waterfall: fees -> interest -> principal
    let remaining = body.amount_cents;
    let appliedFees = 0;
    let appliedInterest = 0;
    let appliedPrincipal = 0;

    // 1. Apply to outstanding fees
    if (remaining > 0 && balances.feesBalance > 0) {
      appliedFees = Math.min(remaining, balances.feesBalance);
      remaining -= appliedFees;
    }

    // 2. Apply to accrued interest
    if (remaining > 0 && balances.interestBalance > 0) {
      appliedInterest = Math.min(remaining, balances.interestBalance);
      remaining -= appliedInterest;
    }

    // 3. Apply to principal
    if (remaining > 0 && balances.principalBalance > 0) {
      appliedPrincipal = Math.min(remaining, balances.principalBalance);
      remaining -= appliedPrincipal;
    }

    // Create repayment record
    const repayment = await app.prisma.repayment.create({
      data: {
        contractId: contract.id,
        amountCents: body.amount_cents,
        fundingInstrumentId: sourceInstrumentId,
        scheduledDate: body.scheduled_date ? new Date(body.scheduled_date) : undefined,
        isPayoff: body.is_payoff ?? false,
        status: body.scheduled_date ? 'SCHEDULED' : 'INITIATED',
        initiatedAt: body.scheduled_date ? undefined : new Date(),
        appliedFeeCents: appliedFees,
        appliedInterestCents: appliedInterest,
        appliedPrincipalCents: appliedPrincipal,
        idempotencyKey,
      },
    });

    // If scheduled for later, just return
    if (body.scheduled_date) {
      reply.status(202);
      return formatRepayment(repayment);
    }

    try {
      // Initiate ACH pull via transfer service
      const transfer = await transferService.initiateTransfer(tenantId, {
        contractId: contract.id,
        sourceAccountId: sourceInstrumentId,
        destinationAccountId: destInstrumentId,
        amountCents: body.amount_cents,
        speed: 'standard', // Repayments are always standard ACH
        direction: 'debit',
        description: `Loan repayment for contract ${contract.id}`,
        metadata: {
          repayment_id: repayment.id,
          contract_id: contract.id,
          is_payoff: String(body.is_payoff ?? false),
        },
        idempotencyKey: idempotencyKey ? `${idempotencyKey}-transfer` : undefined,
      });

      // Update repayment with transfer info
      const updated = await app.prisma.repayment.update({
        where: { id: repayment.id },
        data: {
          providerRef: transfer.id,
          rail: transfer.rail.toUpperCase() as any,
          status: 'PENDING',
          availabilityState: 'PENDING',
        },
      });

      const response = formatRepayment(updated);

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
      // Update repayment as failed
      await app.prisma.repayment.update({
        where: { id: repayment.id },
        data: {
          status: 'FAILED',
          failureReason: (error as Error).message,
        },
      });

      throw error;
    }
  });

  // GET /loan-contracts/:contract_id/repayments
  app.get('/loan-contracts/:contract_id/repayments', {
    schema: {
      description: 'List repayments for a contract',
      tags: ['Repayments'],
    },
  }, async (request) => {
    const { contract_id } = request.params as { contract_id: string };
    const { status, cursor, limit = 20 } = request.query as {
      status?: string;
      cursor?: string;
      limit?: number;
    };

    // Verify contract belongs to tenant
    const contract = await app.prisma.loanContract.findFirst({
      where: { id: contract_id, tenantId: request.user.tenantId },
    });

    if (!contract) {
      throw AppError.notFound('Loan contract');
    }

    const repayments = await app.prisma.repayment.findMany({
      where: {
        contractId: contract_id,
        ...(status && { status: status.toUpperCase() as any }),
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = repayments.length > limit;
    const data = repayments.slice(0, limit);

    return {
      data: data.map(formatRepayment),
      next_cursor: hasMore ? data[data.length - 1]?.id : undefined,
      has_more: hasMore,
    };
  });

  // GET /repayments/:repayment_id
  app.get('/:repayment_id', {
    schema: {
      description: 'Get repayment status',
      tags: ['Repayments'],
    },
  }, async (request) => {
    const { repayment_id } = request.params as { repayment_id: string };

    const repayment = await app.prisma.repayment.findUnique({
      where: { id: repayment_id },
      include: { contract: true },
    });

    if (!repayment || repayment.contract.tenantId !== request.user.tenantId) {
      throw AppError.notFound('Repayment');
    }

    return formatRepayment(repayment);
  });

  // POST /repayments/:repayment_id/cancel
  app.post('/:repayment_id/cancel', {
    schema: {
      description: 'Cancel scheduled repayment',
      tags: ['Repayments'],
    },
  }, async (request) => {
    const { repayment_id } = request.params as { repayment_id: string };
    const tenantId = request.user.tenantId;

    const repayment = await app.prisma.repayment.findUnique({
      where: { id: repayment_id },
      include: { contract: true },
    });

    if (!repayment || repayment.contract.tenantId !== tenantId) {
      throw AppError.notFound('Repayment');
    }

    if (repayment.status !== 'SCHEDULED' && repayment.status !== 'INITIATED') {
      throw AppError.invalidState('Only scheduled or initiated repayments can be cancelled');
    }

    // Cancel underlying transfer if exists
    if (repayment.providerRef) {
      try {
        await transferService.cancelTransfer(tenantId, repayment.providerRef);
      } catch (error) {
        console.warn(`Could not cancel transfer: ${(error as Error).message}`);
      }
    }

    const updated = await app.prisma.repayment.update({
      where: { id: repayment_id },
      data: {
        status: 'CANCELLED',
        failureReason: 'Cancelled by user',
      },
    });

    return formatRepayment(updated);
  });

  // POST /repayments/:repayment_id/retry
  app.post('/:repayment_id/retry', {
    schema: {
      description: 'Retry failed repayment',
      tags: ['Repayments'],
    },
  }, async (request, reply) => {
    const { repayment_id } = request.params as { repayment_id: string };
    const tenantId = request.user.tenantId;

    const repayment = await app.prisma.repayment.findUnique({
      where: { id: repayment_id },
      include: { contract: true },
    });

    if (!repayment || repayment.contract.tenantId !== tenantId) {
      throw AppError.notFound('Repayment');
    }

    if (repayment.status !== 'FAILED') {
      throw AppError.invalidState('Only failed repayments can be retried');
    }

    // Reset status and retry
    await app.prisma.repayment.update({
      where: { id: repayment_id },
      data: {
        status: 'INITIATED',
        initiatedAt: new Date(),
        failureReason: null,
        providerRef: null,
      },
    });

    try {
      // Initiate new transfer
      const transfer = await transferService.initiateTransfer(tenantId, {
        contractId: repayment.contractId,
        sourceAccountId: repayment.fundingInstrumentId,
        destinationAccountId: 'platform', // Lender's account or platform
        amountCents: repayment.amountCents,
        speed: 'standard',
        direction: 'debit',
        description: `Loan repayment retry for contract ${repayment.contractId}`,
        metadata: {
          repayment_id: repayment.id,
          contract_id: repayment.contractId,
          retry: 'true',
        },
      });

      const final = await app.prisma.repayment.update({
        where: { id: repayment_id },
        data: {
          providerRef: transfer.id,
          rail: transfer.rail.toUpperCase() as any,
          status: 'PENDING',
        },
      });

      reply.status(202);
      return formatRepayment(final);
    } catch (error) {
      await app.prisma.repayment.update({
        where: { id: repayment_id },
        data: {
          status: 'FAILED',
          failureReason: (error as Error).message,
        },
      });

      throw error;
    }
  });
}

function formatRepayment(repayment: {
  id: string;
  contractId: string;
  amountCents: number;
  status: string;
  rail: string | null;
  fundingInstrumentId: string;
  appliedFeeCents: number;
  appliedInterestCents: number;
  appliedPrincipalCents: number;
  availabilityState: string;
  scheduledDate: Date | null;
  initiatedAt: Date | null;
  completedAt: Date | null;
  failureReason?: string | null;
  createdAt: Date;
}) {
  return {
    id: repayment.id,
    contract_id: repayment.contractId,
    amount_cents: repayment.amountCents,
    status: repayment.status.toLowerCase(),
    rail: repayment.rail?.toLowerCase(),
    funding_instrument_id: repayment.fundingInstrumentId,
    application: {
      fees_cents: repayment.appliedFeeCents,
      interest_cents: repayment.appliedInterestCents,
      principal_cents: repayment.appliedPrincipalCents,
    },
    availability: {
      state: repayment.availabilityState.toLowerCase(),
    },
    scheduled_date: repayment.scheduledDate?.toISOString().split('T')[0],
    initiated_at: repayment.initiatedAt?.toISOString(),
    completed_at: repayment.completedAt?.toISOString(),
    failure_reason: repayment.failureReason,
    created_at: repayment.createdAt.toISOString(),
  };
}

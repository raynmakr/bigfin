import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { authenticate } from '../../common/middleware/auth.js';

export async function prefundRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);

  // GET /customers/:customer_id/prefund
  app.get('/:customer_id/prefund', {
    schema: {
      description: 'Get prefund account balance',
      tags: ['Prefund'],
    },
  }, async (request) => {
    const { customer_id } = request.params as { customer_id: string };

    const customer = await app.prisma.customer.findFirst({
      where: { id: customer_id, tenantId: request.user.tenantId },
    });

    if (!customer) {
      throw AppError.notFound('Customer');
    }

    // Calculate balance from transactions
    const transactions = await app.prisma.prefundTransaction.findMany({
      where: { customerId: customer_id, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });

    const lastTx = transactions[0];

    return {
      customer_id,
      balance_cents: lastTx?.balanceAfterCents ?? 0,
      available_cents: lastTx?.availableAfterCents ?? 0,
      held_cents: (lastTx?.balanceAfterCents ?? 0) - (lastTx?.availableAfterCents ?? 0),
      pending_deposits_cents: 0,
      pending_withdrawals_cents: 0,
      updated_at: lastTx?.completedAt?.toISOString() ?? new Date().toISOString(),
    };
  });

  // POST /customers/:customer_id/prefund/deposit
  app.post('/:customer_id/prefund/deposit', {
    schema: {
      description: 'Deposit to prefund account',
      tags: ['Prefund'],
    },
  }, async (request, reply) => {
    const { customer_id } = request.params as { customer_id: string };
    const { amount_cents, funding_instrument_id } = request.body as {
      amount_cents: number;
      funding_instrument_id: string;
    };

    const customer = await app.prisma.customer.findFirst({
      where: { id: customer_id, tenantId: request.user.tenantId },
    });

    if (!customer) {
      throw AppError.notFound('Customer');
    }

    // Get current balance
    const lastTx = await app.prisma.prefundTransaction.findFirst({
      where: { customerId: customer_id, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
    });

    const currentBalance = lastTx?.balanceAfterCents ?? 0;

    // Create pending deposit transaction
    const transaction = await app.prisma.prefundTransaction.create({
      data: {
        customerId: customer_id,
        type: 'DEPOSIT',
        amountCents: amount_cents,
        fundingInstrumentId: funding_instrument_id,
        status: 'PENDING',
        balanceAfterCents: currentBalance + amount_cents,
        availableAfterCents: lastTx?.availableAfterCents ?? 0, // Not available until settled
      },
    });

    // TODO: Initiate ACH pull via Moov

    reply.status(202);
    return formatTransaction(transaction);
  });

  // POST /customers/:customer_id/prefund/withdraw
  app.post('/:customer_id/prefund/withdraw', {
    schema: {
      description: 'Withdraw from prefund account',
      tags: ['Prefund'],
    },
  }, async (request, reply) => {
    const { customer_id } = request.params as { customer_id: string };
    const { amount_cents, funding_instrument_id } = request.body as {
      amount_cents: number;
      funding_instrument_id: string;
    };

    const customer = await app.prisma.customer.findFirst({
      where: { id: customer_id, tenantId: request.user.tenantId },
    });

    if (!customer) {
      throw AppError.notFound('Customer');
    }

    // Get current balance
    const lastTx = await app.prisma.prefundTransaction.findFirst({
      where: { customerId: customer_id, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
    });

    const availableBalance = lastTx?.availableAfterCents ?? 0;

    if (amount_cents > availableBalance) {
      throw AppError.insufficientFunds('Insufficient available prefund balance');
    }

    // Create withdrawal transaction
    const transaction = await app.prisma.prefundTransaction.create({
      data: {
        customerId: customer_id,
        type: 'WITHDRAWAL',
        amountCents: amount_cents,
        fundingInstrumentId: funding_instrument_id,
        status: 'PENDING',
        balanceAfterCents: (lastTx?.balanceAfterCents ?? 0) - amount_cents,
        availableAfterCents: availableBalance - amount_cents,
      },
    });

    // TODO: Initiate ACH push via Moov

    reply.status(202);
    return formatTransaction(transaction);
  });

  // GET /customers/:customer_id/prefund/transactions
  app.get('/:customer_id/prefund/transactions', {
    schema: {
      description: 'List prefund transactions',
      tags: ['Prefund'],
    },
  }, async (request) => {
    const { customer_id } = request.params as { customer_id: string };
    const { cursor, limit = 20 } = request.query as { cursor?: string; limit?: number };

    const transactions = await app.prisma.prefundTransaction.findMany({
      where: { customerId: customer_id },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = transactions.length > limit;
    const data = transactions.slice(0, limit);

    return {
      data: data.map(formatTransaction),
      next_cursor: hasMore ? data[data.length - 1]?.id : undefined,
      has_more: hasMore,
    };
  });
}

function formatTransaction(tx: {
  id: string;
  customerId: string;
  type: string;
  amountCents: number;
  status: string;
  rail: string | null;
  createdAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: tx.id,
    customer_id: tx.customerId,
    type: tx.type.toLowerCase(),
    amount_cents: tx.amountCents,
    status: tx.status.toLowerCase(),
    rail: tx.rail?.toLowerCase(),
    created_at: tx.createdAt.toISOString(),
    completed_at: tx.completedAt?.toISOString(),
  };
}

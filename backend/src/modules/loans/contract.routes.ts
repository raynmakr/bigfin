import type { FastifyInstance } from 'fastify';
import { AppError } from '../../common/errors/app-error.js';
import { authenticate } from '../../common/middleware/auth.js';

export async function loanContractRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);

  // GET /loan-contracts - List contracts
  app.get('/', {
    schema: {
      description: 'List loan contracts',
      tags: ['Loan Contracts'],
    },
  }, async (request) => {
    const { lender_id, borrower_id, status, cursor, limit = 20 } = request.query as {
      lender_id?: string;
      borrower_id?: string;
      status?: string;
      cursor?: string;
      limit?: number;
    };

    const contracts = await app.prisma.loanContract.findMany({
      where: {
        tenantId: request.user.tenantId,
        ...(lender_id && { lenderId: lender_id }),
        ...(borrower_id && { borrowerId: borrower_id }),
        ...(status && { status: status.toUpperCase() as any }),
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = contracts.length > limit;
    const data = contracts.slice(0, limit);

    return {
      data: data.map(formatContract),
      next_cursor: hasMore ? data[data.length - 1]?.id : undefined,
      has_more: hasMore,
    };
  });

  // GET /loan-contracts/:contract_id
  app.get('/:contract_id', {
    schema: {
      description: 'Get loan contract details',
      tags: ['Loan Contracts'],
    },
  }, async (request) => {
    const { contract_id } = request.params as { contract_id: string };

    const contract = await app.prisma.loanContract.findFirst({
      where: { id: contract_id, tenantId: request.user.tenantId },
      include: {
        disbursements: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (!contract) {
      throw AppError.notFound('Loan contract');
    }

    return formatContract(contract);
  });

  // GET /loan-contracts/:contract_id/schedule
  app.get('/:contract_id/schedule', {
    schema: {
      description: 'Get repayment schedule',
      tags: ['Loan Contracts'],
    },
  }, async (request) => {
    const { contract_id } = request.params as { contract_id: string };

    const contract = await app.prisma.loanContract.findFirst({
      where: { id: contract_id, tenantId: request.user.tenantId },
    });

    if (!contract) {
      throw AppError.notFound('Loan contract');
    }

    const items = await app.prisma.repaymentScheduleItem.findMany({
      where: { contractId: contract_id },
      orderBy: { sequence: 'asc' },
    });

    const totalPrincipal = items.reduce((sum, i) => sum + i.principalCents, 0);
    const totalInterest = items.reduce((sum, i) => sum + i.interestCents, 0);

    return {
      contract_id,
      items: items.map((item) => ({
        sequence: item.sequence,
        due_date: item.dueDate.toISOString().split('T')[0],
        principal_cents: item.principalCents,
        interest_cents: item.interestCents,
        fees_cents: item.feesCents,
        total_cents: item.principalCents + item.interestCents + item.feesCents,
        status: item.status.toLowerCase(),
        paid_cents: item.paidCents,
        paid_at: item.paidAt?.toISOString(),
      })),
      total_principal_cents: totalPrincipal,
      total_interest_cents: totalInterest,
      total_amount_cents: totalPrincipal + totalInterest,
    };
  });

  // GET /loan-contracts/:contract_id/ledger
  app.get('/:contract_id/ledger', {
    schema: {
      description: 'Get loan ledger entries',
      tags: ['Loan Contracts'],
    },
  }, async (request) => {
    const { contract_id } = request.params as { contract_id: string };
    const { cursor, limit = 50 } = request.query as { cursor?: string; limit?: number };

    const contract = await app.prisma.loanContract.findFirst({
      where: { id: contract_id, tenantId: request.user.tenantId },
    });

    if (!contract) {
      throw AppError.notFound('Loan contract');
    }

    const journals = await app.prisma.ledgerJournal.findMany({
      where: { contractId: contract_id },
      include: { entries: true },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = journals.length > limit;
    const data = journals.slice(0, limit);

    return {
      data: data.flatMap((journal) =>
        journal.entries.map((entry) => ({
          id: entry.id,
          journal_id: journal.id,
          account: entry.accountCode,
          debit_cents: entry.debitCents,
          credit_cents: entry.creditCents,
          balance_after_cents: entry.balanceAfterCents,
          created_at: entry.createdAt.toISOString(),
        }))
      ),
      next_cursor: hasMore ? data[data.length - 1]?.id : undefined,
      has_more: hasMore,
    };
  });

  // GET /loan-contracts/:contract_id/summary
  app.get('/:contract_id/summary', {
    schema: {
      description: 'Get loan summary',
      tags: ['Loan Contracts'],
    },
  }, async (request) => {
    const { contract_id } = request.params as { contract_id: string };

    const contract = await app.prisma.loanContract.findFirst({
      where: { id: contract_id, tenantId: request.user.tenantId },
    });

    if (!contract) {
      throw AppError.notFound('Loan contract');
    }

    // Get next payment
    const nextPayment = await app.prisma.repaymentScheduleItem.findFirst({
      where: {
        contractId: contract_id,
        status: { in: ['SCHEDULED', 'DUE'] },
      },
      orderBy: { dueDate: 'asc' },
    });

    // Count payments
    const [paid, total] = await Promise.all([
      app.prisma.repaymentScheduleItem.count({
        where: { contractId: contract_id, status: 'PAID' },
      }),
      app.prisma.repaymentScheduleItem.count({
        where: { contractId: contract_id },
      }),
    ]);

    // Calculate days past due
    const pastDueItem = await app.prisma.repaymentScheduleItem.findFirst({
      where: { contractId: contract_id, status: 'PAST_DUE' },
      orderBy: { dueDate: 'asc' },
    });

    const daysPastDue = pastDueItem
      ? Math.floor((Date.now() - pastDueItem.dueDate.getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    return {
      contract_id,
      status: contract.status.toLowerCase(),
      balances: {
        principal_cents: contract.principalBalanceCents,
        interest_cents: contract.interestBalanceCents,
        fees_cents: contract.feesBalanceCents,
        total_due_cents: contract.principalBalanceCents + contract.interestBalanceCents + contract.feesBalanceCents,
        payoff_amount_cents: contract.principalBalanceCents + contract.interestBalanceCents + contract.feesBalanceCents,
      },
      next_payment: nextPayment ? {
        sequence: nextPayment.sequence,
        due_date: nextPayment.dueDate.toISOString().split('T')[0],
        total_cents: nextPayment.principalCents + nextPayment.interestCents + nextPayment.feesCents,
      } : null,
      payments_made: paid,
      payments_remaining: total - paid,
      days_past_due: daysPastDue,
    };
  });
}

function formatContract(contract: {
  id: string;
  tenantId: string;
  offerId: string;
  productId: string;
  lenderId: string;
  borrowerId: string;
  status: string;
  principalCents: number;
  aprBps: number;
  termMonths: number;
  paymentFrequency: string;
  firstPaymentDate: Date;
  principalBalanceCents: number;
  interestBalanceCents: number;
  feesBalanceCents: number;
  originatedAt: Date;
  disbursedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: contract.id,
    tenant_id: contract.tenantId,
    offer_id: contract.offerId,
    product_id: contract.productId,
    lender_id: contract.lenderId,
    borrower_id: contract.borrowerId,
    status: contract.status.toLowerCase(),
    terms: {
      principal_cents: contract.principalCents,
      apr_bps: contract.aprBps,
      term_months: contract.termMonths,
      payment_frequency: contract.paymentFrequency.toLowerCase(),
      first_payment_date: contract.firstPaymentDate.toISOString().split('T')[0],
    },
    balances: {
      principal_cents: contract.principalBalanceCents,
      interest_cents: contract.interestBalanceCents,
      fees_cents: contract.feesBalanceCents,
      total_due_cents: contract.principalBalanceCents + contract.interestBalanceCents + contract.feesBalanceCents,
    },
    originated_at: contract.originatedAt.toISOString(),
    disbursed_at: contract.disbursedAt?.toISOString(),
    created_at: contract.createdAt.toISOString(),
  };
}

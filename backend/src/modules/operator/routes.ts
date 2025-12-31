import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { authenticate } from '../../common/middleware/auth.js';

const searchLoansSchema = z.object({
  q: z.string().optional(),
  status: z.string().optional(),
  lender_id: z.string().uuid().optional(),
  borrower_id: z.string().uuid().optional(),
  created_after: z.string().datetime().optional(),
  created_before: z.string().datetime().optional(),
  min_principal: z.coerce.number().int().optional(),
  max_principal: z.coerce.number().int().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const reversalSchema = z.object({
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
});

export async function operatorRoutes(app: FastifyInstance) {
  // Require authentication for all operator routes
  app.addHook('onRequest', authenticate);

  // ============================================================================
  // Loan Search & View
  // ============================================================================

  // GET /operator/loans - Search loans
  app.get('/loans', {
    schema: {
      description: 'Search loans with filters',
      tags: ['Operator'],
    },
  }, async (request) => {
    const query = searchLoansSchema.parse(request.query);
    const tenantId = request.user.tenantId;

    const contracts = await app.prisma.loanContract.findMany({
      where: {
        tenantId,
        ...(query.status && { status: query.status.toUpperCase() as any }),
        ...(query.lender_id && { lenderId: query.lender_id }),
        ...(query.borrower_id && { borrowerId: query.borrower_id }),
        ...(query.created_after && { createdAt: { gte: new Date(query.created_after) } }),
        ...(query.created_before && { createdAt: { lte: new Date(query.created_before) } }),
        ...(query.min_principal && { principalCents: { gte: query.min_principal } }),
        ...(query.max_principal && { principalCents: { lte: query.max_principal } }),
      },
      include: {
        lender: { select: { id: true, firstName: true, lastName: true, email: true } },
        borrower: { select: { id: true, firstName: true, lastName: true, email: true } },
        product: { select: { id: true, name: true } },
      },
      take: query.limit + 1,
      ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = contracts.length > query.limit;
    const data = contracts.slice(0, query.limit);

    return {
      data: data.map((c) => ({
        id: c.id,
        status: c.status.toLowerCase(),
        product: {
          id: c.product.id,
          name: c.product.name,
        },
        principal_cents: c.principalCents,
        apr_bps: c.aprBps,
        term_months: c.termMonths,
        payment_frequency: c.paymentFrequency.toLowerCase(),
        lender: {
          id: c.lender.id,
          name: `${c.lender.firstName} ${c.lender.lastName}`,
          email: c.lender.email,
        },
        borrower: {
          id: c.borrower.id,
          name: `${c.borrower.firstName} ${c.borrower.lastName}`,
          email: c.borrower.email,
        },
        balances: {
          principal_cents: c.principalBalanceCents,
          interest_cents: c.interestBalanceCents,
          fees_cents: c.feesBalanceCents,
          total_cents: c.principalBalanceCents + c.interestBalanceCents + c.feesBalanceCents,
        },
        originated_at: c.originatedAt.toISOString(),
        disbursed_at: c.disbursedAt?.toISOString(),
        paid_off_at: c.paidOffAt?.toISOString(),
        created_at: c.createdAt.toISOString(),
      })),
      next_cursor: hasMore ? data[data.length - 1]?.id : undefined,
      has_more: hasMore,
    };
  });

  // GET /operator/loans/:loan_id - View single loan
  app.get('/loans/:loan_id', {
    schema: {
      description: 'Get loan details',
      tags: ['Operator'],
    },
  }, async (request) => {
    const { loan_id } = request.params as { loan_id: string };
    const tenantId = request.user.tenantId;

    const contract = await app.prisma.loanContract.findFirst({
      where: {
        id: loan_id,
        tenantId,
      },
      include: {
        lender: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        borrower: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        product: { select: { id: true, name: true, code: true } },
        offer: { select: { id: true, createdAt: true, expiresAt: true, respondedAt: true } },
        _count: {
          select: {
            disbursements: true,
            repayments: true,
            ledgerJournals: true,
            documents: true,
          },
        },
      },
    });

    if (!contract) {
      throw AppError.notFound('Loan contract');
    }

    // Get next scheduled payment
    const nextPayment = await app.prisma.repaymentScheduleItem.findFirst({
      where: {
        contractId: loan_id,
        status: { in: ['SCHEDULED', 'DUE'] },
      },
      orderBy: { dueDate: 'asc' },
    });

    // Get payment stats
    const [disbursementStats, repaymentStats] = await Promise.all([
      app.prisma.disbursement.aggregate({
        where: { contractId: loan_id },
        _sum: { amountCents: true, expressFeeCents: true },
        _count: true,
      }),
      app.prisma.repayment.aggregate({
        where: { contractId: loan_id, status: 'COMPLETED' },
        _sum: { amountCents: true },
        _count: true,
      }),
    ]);

    return {
      id: contract.id,
      status: contract.status.toLowerCase(),
      product: {
        id: contract.product.id,
        name: contract.product.name,
        code: contract.product.code,
      },
      terms: {
        principal_cents: contract.principalCents,
        apr_bps: contract.aprBps,
        term_months: contract.termMonths,
        payment_frequency: contract.paymentFrequency.toLowerCase(),
        first_payment_date: contract.firstPaymentDate.toISOString().split('T')[0],
      },
      lender: {
        id: contract.lender.id,
        name: `${contract.lender.firstName} ${contract.lender.lastName}`,
        email: contract.lender.email,
        phone: contract.lender.phone,
      },
      borrower: {
        id: contract.borrower.id,
        name: `${contract.borrower.firstName} ${contract.borrower.lastName}`,
        email: contract.borrower.email,
        phone: contract.borrower.phone,
      },
      balances: {
        principal_cents: contract.principalBalanceCents,
        interest_cents: contract.interestBalanceCents,
        fees_cents: contract.feesBalanceCents,
        total_cents: contract.principalBalanceCents + contract.interestBalanceCents + contract.feesBalanceCents,
      },
      stats: {
        total_disbursed_cents: disbursementStats._sum.amountCents || 0,
        total_express_fees_cents: disbursementStats._sum.expressFeeCents || 0,
        total_repaid_cents: repaymentStats._sum.amountCents || 0,
        disbursement_count: disbursementStats._count,
        repayment_count: repaymentStats._count,
        journal_count: contract._count.ledgerJournals,
        document_count: contract._count.documents,
      },
      next_payment: nextPayment ? {
        due_date: nextPayment.dueDate.toISOString().split('T')[0],
        principal_cents: nextPayment.principalCents,
        interest_cents: nextPayment.interestCents,
        fees_cents: nextPayment.feesCents,
        total_cents: nextPayment.principalCents + nextPayment.interestCents + nextPayment.feesCents,
        status: nextPayment.status.toLowerCase(),
      } : null,
      offer: {
        id: contract.offer.id,
        created_at: contract.offer.createdAt.toISOString(),
        expires_at: contract.offer.expiresAt.toISOString(),
        responded_at: contract.offer.respondedAt?.toISOString(),
      },
      originated_at: contract.originatedAt.toISOString(),
      disbursed_at: contract.disbursedAt?.toISOString(),
      paid_off_at: contract.paidOffAt?.toISOString(),
      defaulted_at: contract.defaultedAt?.toISOString(),
      created_at: contract.createdAt.toISOString(),
    };
  });

  // ============================================================================
  // Loan Ledger
  // ============================================================================

  // GET /operator/loans/:loan_id/ledger - View loan ledger entries
  app.get('/loans/:loan_id/ledger', {
    schema: {
      description: 'Get loan ledger entries',
      tags: ['Operator'],
    },
  }, async (request) => {
    const { loan_id } = request.params as { loan_id: string };
    const query = request.query as { cursor?: string; limit?: string };
    const limit = query.limit ? parseInt(query.limit) : 50;
    const tenantId = request.user.tenantId;

    // Verify loan belongs to tenant
    const contract = await app.prisma.loanContract.findFirst({
      where: { id: loan_id, tenantId },
      select: { id: true },
    });

    if (!contract) {
      throw AppError.notFound('Loan contract');
    }

    const journals = await app.prisma.ledgerJournal.findMany({
      where: { contractId: loan_id },
      include: {
        entries: {
          orderBy: { accountCode: 'asc' },
        },
        reversesJournal: { select: { id: true, description: true } },
        reversedByJournal: { select: { id: true, description: true } },
      },
      take: limit + 1,
      ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = journals.length > limit;
    const data = journals.slice(0, limit);

    return {
      data: data.map((j) => ({
        id: j.id,
        type: j.type.toLowerCase(),
        description: j.description,
        is_reversal: j.isReversal,
        reverses_journal: j.reversesJournal ? {
          id: j.reversesJournal.id,
          description: j.reversesJournal.description,
        } : null,
        reversed_by_journal: j.reversedByJournal ? {
          id: j.reversedByJournal.id,
          description: j.reversedByJournal.description,
        } : null,
        reversal_reason: j.reversalReason,
        entries: j.entries.map((e) => ({
          account_code: e.accountCode,
          debit_cents: e.debitCents,
          credit_cents: e.creditCents,
          balance_after_cents: e.balanceAfterCents,
        })),
        created_by: j.createdBy,
        created_at: j.createdAt.toISOString(),
      })),
      next_cursor: hasMore ? data[data.length - 1]?.id : undefined,
      has_more: hasMore,
    };
  });

  // ============================================================================
  // Payment Timeline
  // ============================================================================

  // GET /operator/loans/:loan_id/payments - View payment timeline
  app.get('/loans/:loan_id/payments', {
    schema: {
      description: 'Get loan payment timeline (disbursements + repayments)',
      tags: ['Operator'],
    },
  }, async (request) => {
    const { loan_id } = request.params as { loan_id: string };
    const tenantId = request.user.tenantId;

    // Verify loan belongs to tenant
    const contract = await app.prisma.loanContract.findFirst({
      where: { id: loan_id, tenantId },
      select: { id: true },
    });

    if (!contract) {
      throw AppError.notFound('Loan contract');
    }

    // Get all disbursements and repayments
    const [disbursements, repayments] = await Promise.all([
      app.prisma.disbursement.findMany({
        where: { contractId: loan_id },
        include: {
          fundingInstrument: { select: { id: true, type: true, last4: true, bankName: true } },
        },
        orderBy: { initiatedAt: 'desc' },
      }),
      app.prisma.repayment.findMany({
        where: { contractId: loan_id },
        include: {
          fundingInstrument: { select: { id: true, type: true, last4: true, bankName: true } },
        },
        orderBy: { initiatedAt: 'desc' },
      }),
    ]);

    // Combine into timeline
    const timeline = [
      ...disbursements.map((d) => ({
        id: d.id,
        type: 'disbursement' as const,
        amount_cents: d.amountCents,
        express_fee_cents: d.expressFeeCents,
        net_amount_cents: d.netAmountCents,
        speed: d.speed.toLowerCase(),
        rail: d.rail?.toLowerCase(),
        status: d.status.toLowerCase(),
        availability_state: d.availabilityState.toLowerCase(),
        funding_instrument: {
          id: d.fundingInstrument.id,
          type: d.fundingInstrument.type.toLowerCase(),
          last_four: d.fundingInstrument.last4,
          bank_name: d.fundingInstrument.bankName,
        },
        provider_ref: d.providerRef,
        initiated_at: d.initiatedAt.toISOString(),
        completed_at: d.completedAt?.toISOString(),
        failed_at: d.failedAt?.toISOString(),
        failure_reason: d.failureReason,
        available_at: d.availableAt?.toISOString(),
        hold_reason: d.holdReason,
      })),
      ...repayments.map((r) => ({
        id: r.id,
        type: 'repayment' as const,
        amount_cents: r.amountCents,
        rail: r.rail?.toLowerCase(),
        status: r.status.toLowerCase(),
        availability_state: r.availabilityState.toLowerCase(),
        funding_instrument: {
          id: r.fundingInstrument.id,
          type: r.fundingInstrument.type.toLowerCase(),
          last_four: r.fundingInstrument.last4,
          bank_name: r.fundingInstrument.bankName,
        },
        application: {
          fee_cents: r.appliedFeeCents,
          interest_cents: r.appliedInterestCents,
          principal_cents: r.appliedPrincipalCents,
        },
        provider_ref: r.providerRef,
        scheduled_date: r.scheduledDate?.toISOString().split('T')[0],
        is_payoff: r.isPayoff,
        initiated_at: r.initiatedAt?.toISOString(),
        completed_at: r.completedAt?.toISOString(),
        failed_at: r.failedAt?.toISOString(),
        failure_reason: r.failureReason,
        available_at: r.availableAt?.toISOString(),
        hold_reason: r.holdReason,
      })),
    ].sort((a, b) => {
      const aTime = a.initiated_at || '';
      const bTime = b.initiated_at || '';
      return bTime.localeCompare(aTime);
    });

    return {
      disbursements: {
        count: disbursements.length,
        total_cents: disbursements.reduce((sum, d) => sum + d.amountCents, 0),
        completed_cents: disbursements
          .filter((d) => d.status === 'COMPLETED')
          .reduce((sum, d) => sum + d.amountCents, 0),
      },
      repayments: {
        count: repayments.length,
        total_cents: repayments.reduce((sum, r) => sum + r.amountCents, 0),
        completed_cents: repayments
          .filter((r) => r.status === 'COMPLETED')
          .reduce((sum, r) => sum + r.amountCents, 0),
      },
      timeline,
    };
  });

  // ============================================================================
  // Repayment Schedule
  // ============================================================================

  // GET /operator/loans/:loan_id/schedule - View repayment schedule
  app.get('/loans/:loan_id/schedule', {
    schema: {
      description: 'Get loan repayment schedule',
      tags: ['Operator'],
    },
  }, async (request) => {
    const { loan_id } = request.params as { loan_id: string };
    const tenantId = request.user.tenantId;

    // Verify loan belongs to tenant
    const contract = await app.prisma.loanContract.findFirst({
      where: { id: loan_id, tenantId },
      select: { id: true },
    });

    if (!contract) {
      throw AppError.notFound('Loan contract');
    }

    const scheduleItems = await app.prisma.repaymentScheduleItem.findMany({
      where: { contractId: loan_id },
      orderBy: { sequence: 'asc' },
    });

    // Calculate totals
    const totalDue = scheduleItems.reduce(
      (sum, item) => sum + item.principalCents + item.interestCents + item.feesCents,
      0
    );
    const totalPaid = scheduleItems.reduce((sum, item) => sum + item.paidCents, 0);
    const totalRemaining = totalDue - totalPaid;

    return {
      summary: {
        total_payments: scheduleItems.length,
        paid_payments: scheduleItems.filter((i) => i.status === 'PAID').length,
        partial_payments: scheduleItems.filter((i) => i.status === 'PARTIAL').length,
        past_due_payments: scheduleItems.filter((i) => i.status === 'PAST_DUE').length,
        total_due_cents: totalDue,
        total_paid_cents: totalPaid,
        total_remaining_cents: totalRemaining,
      },
      items: scheduleItems.map((item) => ({
        sequence: item.sequence,
        due_date: item.dueDate.toISOString().split('T')[0],
        principal_cents: item.principalCents,
        interest_cents: item.interestCents,
        fees_cents: item.feesCents,
        total_cents: item.principalCents + item.interestCents + item.feesCents,
        status: item.status.toLowerCase(),
        paid_cents: item.paidCents,
        remaining_cents: item.principalCents + item.interestCents + item.feesCents - item.paidCents,
        paid_at: item.paidAt?.toISOString(),
      })),
    };
  });

  // ============================================================================
  // Journal Reversal
  // ============================================================================

  // POST /operator/ledger-journals/:journal_id/reverse
  app.post('/ledger-journals/:journal_id/reverse', {
    schema: {
      description: 'Reverse ledger journal (requires step-up auth)',
      tags: ['Operator'],
    },
  }, async (request, reply) => {
    const { journal_id } = request.params as { journal_id: string };
    const body = reversalSchema.parse(request.body);
    const stepUpToken = request.headers['x-step-up-token'];
    const tenantId = request.user.tenantId;

    // Require admin role for reversals
    if (request.user.role !== 'ADMIN') {
      throw AppError.forbidden('Only admins can reverse journal entries');
    }

    if (!stepUpToken) {
      throw AppError.unauthorized('Step-up authentication required for journal reversal');
    }

    // TODO: Verify step-up token with auth service
    // For now, accept any non-empty token

    const journal = await app.prisma.ledgerJournal.findUnique({
      where: { id: journal_id },
      include: {
        entries: true,
        contract: { select: { tenantId: true } },
      },
    });

    if (!journal) {
      throw AppError.notFound('Ledger journal');
    }

    // Verify tenant access
    if (journal.contract && journal.contract.tenantId !== tenantId) {
      throw AppError.notFound('Ledger journal');
    }

    if (journal.reversedByJournalId) {
      throw AppError.invalidState('Journal has already been reversed');
    }

    if (journal.isReversal) {
      throw AppError.invalidState('Cannot reverse a reversal journal');
    }

    // Create reversal journal with opposite entries
    const reversalJournal = await app.prisma.$transaction(async (tx) => {
      const reversal = await tx.ledgerJournal.create({
        data: {
          contractId: journal.contractId,
          type: 'REVERSAL',
          description: `Reversal of ${journal.id}: ${body.reason}`,
          isReversal: true,
          reversesJournalId: journal.id,
          reversalReason: body.reason,
          createdBy: request.user.sub,
        },
      });

      // Create reversed entries (swap debits and credits)
      for (const entry of journal.entries) {
        await tx.ledgerEntry.create({
          data: {
            journalId: reversal.id,
            accountCode: entry.accountCode,
            debitCents: entry.creditCents, // Swap
            creditCents: entry.debitCents, // Swap
            balanceAfterCents: 0, // Will be recalculated
          },
        });
      }

      // Mark original journal as reversed
      await tx.ledgerJournal.update({
        where: { id: journal.id },
        data: { reversedByJournalId: reversal.id },
      });

      return reversal;
    });

    // Create audit log
    await app.prisma.auditLog.create({
      data: {
        tenantId,
        userId: request.user.sub,
        action: 'journal_reversal',
        entityType: 'LedgerJournal',
        entityId: journal_id,
        changes: {
          reason: body.reason,
          reversal_journal_id: reversalJournal.id,
          original_entries: journal.entries.map((e) => ({
            account: e.accountCode,
            debit: e.debitCents,
            credit: e.creditCents,
          })),
        },
      },
    });

    reply.status(201);
    return {
      id: reversalJournal.id,
      type: 'reversal',
      reverses_journal_id: journal.id,
      reason: body.reason,
      entries: journal.entries.map((e) => ({
        account_code: e.accountCode,
        debit_cents: e.creditCents, // Swapped
        credit_cents: e.debitCents, // Swapped
      })),
      created_at: reversalJournal.createdAt.toISOString(),
    };
  });

  // ============================================================================
  // Customer Lookup
  // ============================================================================

  // GET /operator/customers - Search customers
  app.get('/customers', {
    schema: {
      description: 'Search customers',
      tags: ['Operator'],
    },
  }, async (request) => {
    const { q, role, cursor, limit = 20 } = request.query as {
      q?: string;
      role?: string;
      cursor?: string;
      limit?: number;
    };
    const tenantId = request.user.tenantId;

    const customers = await app.prisma.customer.findMany({
      where: {
        tenantId,
        ...(role && { role: role.toUpperCase() as any }),
        ...(q && {
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        }),
      },
      include: {
        _count: {
          select: {
            contractsAsLender: true,
            contractsAsBorrower: true,
            fundingInstruments: true,
          },
        },
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = customers.length > limit;
    const data = customers.slice(0, limit);

    return {
      data: data.map((c) => ({
        id: c.id,
        role: c.role.toLowerCase(),
        name: `${c.firstName} ${c.lastName}`,
        email: c.email,
        phone: c.phone,
        kyc_level: c.kycLevel,
        loan_count: c._count.contractsAsLender + c._count.contractsAsBorrower,
        funding_instrument_count: c._count.fundingInstruments,
        created_at: c.createdAt.toISOString(),
      })),
      next_cursor: hasMore ? data[data.length - 1]?.id : undefined,
      has_more: hasMore,
    };
  });

  // GET /operator/customers/:customer_id - View customer details
  app.get('/customers/:customer_id', {
    schema: {
      description: 'Get customer details',
      tags: ['Operator'],
    },
  }, async (request) => {
    const { customer_id } = request.params as { customer_id: string };
    const tenantId = request.user.tenantId;

    const customer = await app.prisma.customer.findFirst({
      where: { id: customer_id, tenantId },
      include: {
        fundingInstruments: {
          select: {
            id: true,
            type: true,
            status: true,
            last4: true,
            bankName: true,
            isDefault: true,
          },
        },
        contractsAsLender: {
          select: { id: true, status: true, principalCents: true, createdAt: true },
          take: 5,
          orderBy: { createdAt: 'desc' },
        },
        contractsAsBorrower: {
          select: { id: true, status: true, principalCents: true, createdAt: true },
          take: 5,
          orderBy: { createdAt: 'desc' },
        },
        prefundTransactions: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: { availableAfterCents: true },
        },
        _count: {
          select: {
            contractsAsLender: true,
            contractsAsBorrower: true,
          },
        },
      },
    });

    if (!customer) {
      throw AppError.notFound('Customer');
    }

    return {
      id: customer.id,
      role: customer.role.toLowerCase(),
      first_name: customer.firstName,
      last_name: customer.lastName,
      email: customer.email,
      phone: customer.phone,
      kyc_level: customer.kycLevel,
      prefund_balance_cents: customer.prefundTransactions[0]?.availableAfterCents || 0,
      funding_instruments: customer.fundingInstruments.map((fi) => ({
        id: fi.id,
        type: fi.type.toLowerCase(),
        status: fi.status.toLowerCase(),
        last_four: fi.last4,
        bank_name: fi.bankName,
        is_default: fi.isDefault,
      })),
      recent_lender_contracts: customer.contractsAsLender.map((c) => ({
        id: c.id,
        status: c.status.toLowerCase(),
        principal_cents: c.principalCents,
        created_at: c.createdAt.toISOString(),
      })),
      recent_borrower_contracts: customer.contractsAsBorrower.map((c) => ({
        id: c.id,
        status: c.status.toLowerCase(),
        principal_cents: c.principalCents,
        created_at: c.createdAt.toISOString(),
      })),
      total_lender_contracts: customer._count.contractsAsLender,
      total_borrower_contracts: customer._count.contractsAsBorrower,
      created_at: customer.createdAt.toISOString(),
    };
  });

  // ============================================================================
  // Audit Log
  // ============================================================================

  // GET /operator/audit-logs - View audit logs
  app.get('/audit-logs', {
    schema: {
      description: 'View audit logs',
      tags: ['Operator'],
    },
  }, async (request) => {
    const { entity_type, entity_id, user_id, action, cursor, limit = 50 } = request.query as {
      entity_type?: string;
      entity_id?: string;
      user_id?: string;
      action?: string;
      cursor?: string;
      limit?: number;
    };
    const tenantId = request.user.tenantId;

    const logs = await app.prisma.auditLog.findMany({
      where: {
        tenantId,
        ...(entity_type && { entityType: entity_type }),
        ...(entity_id && { entityId: entity_id }),
        ...(user_id && { userId: user_id }),
        ...(action && { action }),
      },
      include: {
        user: { select: { id: true, email: true } },
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = logs.length > limit;
    const data = logs.slice(0, limit);

    return {
      data: data.map((log) => ({
        id: log.id,
        action: log.action,
        entity_type: log.entityType,
        entity_id: log.entityId,
        user: log.user ? {
          id: log.user.id,
          email: log.user.email,
        } : null,
        changes: log.changes,
        ip_address: log.ipAddress,
        user_agent: log.userAgent,
        created_at: log.createdAt.toISOString(),
      })),
      next_cursor: hasMore ? data[data.length - 1]?.id : undefined,
      has_more: hasMore,
    };
  });
}

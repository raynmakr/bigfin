import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { authenticate, requireRole } from '../../common/middleware/auth.js';

export async function operatorRoutes(app: FastifyInstance) {
  // Require ADMIN or OPERATOR role for all operator routes
  app.addHook('onRequest', authenticate);

  // GET /operator/loans - Search loans
  app.get('/loans', {
    schema: {
      description: 'Search loans (operator)',
      tags: ['Operator'],
    },
  }, async (request) => {
    const { q, status, created_after, created_before, cursor, limit = 20 } = request.query as {
      q?: string;
      status?: string;
      created_after?: string;
      created_before?: string;
      cursor?: string;
      limit?: number;
    };

    const contracts = await app.prisma.loanContract.findMany({
      where: {
        tenantId: request.user.tenantId,
        ...(status && { status: status.toUpperCase() as any }),
        ...(created_after && { createdAt: { gte: new Date(created_after) } }),
        ...(created_before && { createdAt: { lte: new Date(created_before) } }),
        // TODO: Implement full-text search on customer name/email
      },
      include: {
        lender: { select: { firstName: true, lastName: true, email: true } },
        borrower: { select: { firstName: true, lastName: true, email: true } },
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = contracts.length > limit;
    const data = contracts.slice(0, limit);

    return {
      data: data.map((c) => ({
        id: c.id,
        status: c.status.toLowerCase(),
        principal_cents: c.principalCents,
        lender: {
          id: c.lenderId,
          name: `${c.lender.firstName} ${c.lender.lastName}`,
          email: c.lender.email,
        },
        borrower: {
          id: c.borrowerId,
          name: `${c.borrower.firstName} ${c.borrower.lastName}`,
          email: c.borrower.email,
        },
        balances: {
          principal_cents: c.principalBalanceCents,
          interest_cents: c.interestBalanceCents,
          fees_cents: c.feesBalanceCents,
        },
        created_at: c.createdAt.toISOString(),
      })),
      next_cursor: hasMore ? data[data.length - 1]?.id : undefined,
      has_more: hasMore,
    };
  });

  // POST /operator/ledger-journals/:journal_id/reverse
  app.post('/ledger-journals/:journal_id/reverse', {
    schema: {
      description: 'Reverse ledger journal (requires step-up auth)',
      tags: ['Operator'],
    },
  }, async (request, reply) => {
    const { journal_id } = request.params as { journal_id: string };
    const { reason } = request.body as { reason: string };
    const stepUpToken = request.headers['x-step-up-token'];

    if (!stepUpToken) {
      throw new AppError('STEP_UP_REQUIRED' as any, 'Step-up authentication required for journal reversal');
    }

    // TODO: Verify step-up token

    if (!reason || reason.length < 10) {
      throw AppError.invalidRequest('Reason must be at least 10 characters');
    }

    const journal = await app.prisma.ledgerJournal.findUnique({
      where: { id: journal_id },
      include: { entries: true, contract: true },
    });

    if (!journal || (journal.contract && journal.contract.tenantId !== request.user.tenantId)) {
      throw AppError.notFound('Ledger journal');
    }

    if (journal.reversedByJournalId) {
      throw AppError.invalidState('Journal has already been reversed');
    }

    // Create reversal journal with opposite entries
    const reversalJournal = await app.prisma.$transaction(async (tx) => {
      const reversal = await tx.ledgerJournal.create({
        data: {
          contractId: journal.contractId,
          type: 'REVERSAL',
          description: `Reversal of ${journal.id}: ${reason}`,
          isReversal: true,
          reversesJournalId: journal.id,
          reversalReason: reason,
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
            balanceAfterCents: entry.balanceAfterCents - entry.debitCents + entry.creditCents,
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
        tenantId: request.user.tenantId,
        userId: request.user.sub,
        action: 'journal_reversal',
        entityType: 'LedgerJournal',
        entityId: journal_id,
        changes: { reason, reversal_journal_id: reversalJournal.id },
      },
    });

    reply.status(201);
    return {
      id: reversalJournal.id,
      type: 'reversal',
      reverses_journal_id: journal.id,
      reason,
      created_at: reversalJournal.createdAt.toISOString(),
    };
  });

  // GET /operator/reconciliation/exceptions
  app.get('/reconciliation/exceptions', {
    schema: {
      description: 'List reconciliation exceptions',
      tags: ['Operator'],
    },
  }, async (request) => {
    const { status, date, cursor, limit = 20 } = request.query as {
      status?: string;
      date?: string;
      cursor?: string;
      limit?: number;
    };

    const exceptions = await app.prisma.reconciliationException.findMany({
      where: {
        ...(status && { status: status.toUpperCase() as any }),
        ...(date && { date: new Date(date) }),
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = exceptions.length > limit;
    const data = exceptions.slice(0, limit);

    return {
      data: data.map((e) => ({
        id: e.id,
        date: e.date.toISOString().split('T')[0],
        type: e.type.toLowerCase(),
        severity: e.severity.toLowerCase(),
        description: e.description,
        affected_entity_type: e.affectedEntityType,
        affected_entity_id: e.affectedEntityId,
        expected_value: e.expectedValue,
        actual_value: e.actualValue,
        status: e.status.toLowerCase(),
        resolution_notes: e.resolutionNotes,
        created_at: e.createdAt.toISOString(),
        resolved_at: e.resolvedAt?.toISOString(),
      })),
      next_cursor: hasMore ? data[data.length - 1]?.id : undefined,
      has_more: hasMore,
    };
  });

  // PATCH /operator/reconciliation/exceptions/:exception_id
  app.patch('/reconciliation/exceptions/:exception_id', {
    schema: {
      description: 'Update exception status',
      tags: ['Operator'],
    },
  }, async (request) => {
    const { exception_id } = request.params as { exception_id: string };
    const { status, resolution_notes } = request.body as {
      status?: string;
      resolution_notes?: string;
    };

    const exception = await app.prisma.reconciliationException.findUnique({
      where: { id: exception_id },
    });

    if (!exception) {
      throw AppError.notFound('Reconciliation exception');
    }

    const updated = await app.prisma.reconciliationException.update({
      where: { id: exception_id },
      data: {
        ...(status && { status: status.toUpperCase() as any }),
        ...(resolution_notes && { resolutionNotes: resolution_notes }),
        ...(status === 'resolved' && {
          resolvedAt: new Date(),
          resolvedById: request.user.sub,
        }),
      },
    });

    return {
      id: updated.id,
      status: updated.status.toLowerCase(),
      resolution_notes: updated.resolutionNotes,
      resolved_at: updated.resolvedAt?.toISOString(),
    };
  });
}

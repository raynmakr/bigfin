import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../common/middleware/auth.js';
import { LedgerService } from './service.js';

export async function ledgerRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);

  const ledgerService = new LedgerService(app.prisma);

  // GET /ledger/accounts - List ledger accounts
  app.get('/accounts', {
    schema: {
      description: 'List all ledger accounts',
      tags: ['Ledger'],
    },
  }, async () => {
    const accounts = await app.prisma.ledgerAccount.findMany({
      orderBy: { code: 'asc' },
    });

    return {
      data: accounts.map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        type: a.type.toLowerCase(),
        is_system: a.isSystem,
        parent_code: a.parentCode,
      })),
    };
  });

  // GET /ledger/trial-balance - Get trial balance
  app.get('/trial-balance', {
    schema: {
      description: 'Get trial balance (all accounts with balances)',
      tags: ['Ledger'],
    },
  }, async () => {
    const trialBalance = await ledgerService.getTrialBalance();

    return {
      accounts: trialBalance.accounts.map((a) => ({
        account_code: a.accountCode,
        account_name: a.accountName,
        debit_cents: a.debitBalance,
        credit_cents: a.creditBalance,
        net_balance_cents: a.netBalance,
      })),
      total_debits_cents: trialBalance.totalDebits,
      total_credits_cents: trialBalance.totalCredits,
      is_balanced: trialBalance.isBalanced,
    };
  });

  // GET /ledger/balances/:account_code - Get account balance
  app.get('/balances/:account_code', {
    schema: {
      description: 'Get balance for a specific account',
      tags: ['Ledger'],
      params: {
        type: 'object',
        properties: {
          account_code: { type: 'string' },
        },
        required: ['account_code'],
      },
    },
  }, async (request) => {
    const { account_code } = request.params as { account_code: string };

    // Decode the account code (colons are URL-encoded)
    const decodedCode = decodeURIComponent(account_code);
    const balance = await ledgerService.getAccountBalance(decodedCode);

    return {
      account_code: decodedCode,
      balance_cents: balance,
    };
  });

  // GET /ledger/contracts/:contract_id/balances - Get loan balances
  app.get('/contracts/:contract_id/balances', {
    schema: {
      description: 'Get loan balances (principal, interest, fees) for a contract',
      tags: ['Ledger'],
      params: {
        type: 'object',
        properties: {
          contract_id: { type: 'string', format: 'uuid' },
        },
        required: ['contract_id'],
      },
    },
  }, async (request) => {
    const { contract_id } = request.params as { contract_id: string };

    const balances = await ledgerService.getLoanBalances(contract_id);

    return {
      contract_id,
      principal_cents: balances.principalBalance,
      interest_cents: balances.interestBalance,
      fees_cents: balances.feesBalance,
      total_cents: balances.totalBalance,
    };
  });

  // GET /ledger/contracts/:contract_id/journals - Get contract journals
  app.get('/contracts/:contract_id/journals', {
    schema: {
      description: 'Get journal history for a contract',
      tags: ['Ledger'],
      params: {
        type: 'object',
        properties: {
          contract_id: { type: 'string', format: 'uuid' },
        },
        required: ['contract_id'],
      },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request) => {
    const { contract_id } = request.params as { contract_id: string };
    const { limit, offset } = request.query as { limit?: number; offset?: number };

    const journals = await ledgerService.getContractJournals(contract_id, { limit, offset });

    return {
      data: journals.map((j) => ({
        id: j.id,
        contract_id: j.contractId,
        type: j.type.toLowerCase(),
        description: j.description,
        is_reversal: j.isReversal,
        reverses_journal_id: j.reversesJournalId,
        reversed_by_journal_id: j.reversedByJournalId,
        created_at: j.createdAt.toISOString(),
        entries: j.entries.map((e) => ({
          id: e.id,
          account_code: e.accountCode,
          debit_cents: e.debitCents,
          credit_cents: e.creditCents,
          balance_after_cents: e.balanceAfterCents,
        })),
      })),
    };
  });

  // GET /ledger/journals - List all journals
  app.get('/journals', {
    schema: {
      description: 'List ledger journals',
      tags: ['Ledger'],
    },
  }, async (request) => {
    const { contract_id, type, cursor, limit = 50 } = request.query as {
      contract_id?: string;
      type?: string;
      cursor?: string;
      limit?: number;
    };

    const journals = await app.prisma.ledgerJournal.findMany({
      where: {
        ...(contract_id && { contractId: contract_id }),
        ...(type && { type: type.toUpperCase() as any }),
      },
      include: { entries: true },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = journals.length > limit;
    const data = journals.slice(0, limit);

    return {
      data: data.map((j) => ({
        id: j.id,
        contract_id: j.contractId,
        type: j.type.toLowerCase(),
        description: j.description,
        is_reversal: j.isReversal,
        reverses_journal_id: j.reversesJournalId,
        reversed_by_journal_id: j.reversedByJournalId,
        created_at: j.createdAt.toISOString(),
        entries: j.entries.map((e) => ({
          id: e.id,
          account_code: e.accountCode,
          debit_cents: e.debitCents,
          credit_cents: e.creditCents,
          balance_after_cents: e.balanceAfterCents,
        })),
      })),
      next_cursor: hasMore ? data[data.length - 1]?.id : undefined,
      has_more: hasMore,
    };
  });
}

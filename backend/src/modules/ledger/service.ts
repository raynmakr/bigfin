import { PrismaClient, JournalType, Prisma } from '@prisma/client';
import { AppError } from '../../common/errors/app-error.js';
import {
  CreateJournalInput,
  LedgerEntry,
  AccountBalance,
  LoanBalances,
  JournalWithEntries,
  AccountCodes,
  DisbursementInput,
  RepaymentInput,
  FeeAssessmentInput,
  InterestAccrualInput,
  WriteOffInput,
} from './types.js';

export class LedgerService {
  constructor(private prisma: PrismaClient) {}

  // ============================================================================
  // Core Journal Operations
  // ============================================================================

  /**
   * Create a balanced journal with entries.
   * Validates that total debits equal total credits.
   * Updates running balances for each account.
   */
  async createJournal(input: CreateJournalInput): Promise<JournalWithEntries> {
    // Validate entries are balanced
    this.validateBalance(input.entries);

    // Validate all account codes exist
    await this.validateAccountCodes(input.entries.map((e) => e.accountCode));

    return this.prisma.$transaction(async (tx) => {
      // Create the journal
      const journal = await tx.ledgerJournal.create({
        data: {
          contractId: input.contractId,
          type: input.type,
          description: input.description,
          createdBy: input.createdBy,
        },
      });

      // Create entries with running balances
      const entries = [];
      for (const entry of input.entries) {
        // Get current balance for this account
        const currentBalance = await this.getAccountBalanceInternal(tx, entry.accountCode);

        // Calculate new balance (debits increase assets/expenses, credits increase liabilities/revenue/equity)
        const account = await tx.ledgerAccount.findUnique({
          where: { code: entry.accountCode },
        });

        let newBalance: number;
        if (account?.type === 'ASSET' || account?.type === 'EXPENSE') {
          // Normal debit balance accounts
          newBalance = currentBalance + entry.debitCents - entry.creditCents;
        } else {
          // Normal credit balance accounts (LIABILITY, EQUITY, REVENUE)
          newBalance = currentBalance + entry.creditCents - entry.debitCents;
        }

        const createdEntry = await tx.ledgerEntry.create({
          data: {
            journalId: journal.id,
            accountCode: entry.accountCode,
            debitCents: entry.debitCents,
            creditCents: entry.creditCents,
            balanceAfterCents: newBalance,
          },
        });

        entries.push(createdEntry);
      }

      return {
        id: journal.id,
        contractId: journal.contractId,
        type: journal.type,
        description: journal.description,
        isReversal: journal.isReversal,
        reversesJournalId: journal.reversesJournalId,
        reversedByJournalId: journal.reversedByJournalId,
        createdAt: journal.createdAt,
        entries,
      };
    });
  }

  /**
   * Reverse a journal by creating a new journal with opposite entries.
   * The original journal is marked as reversed.
   */
  async reverseJournal(
    journalId: string,
    reason: string,
    createdBy?: string
  ): Promise<JournalWithEntries> {
    const original = await this.prisma.ledgerJournal.findUnique({
      where: { id: journalId },
      include: { entries: true },
    });

    if (!original) {
      throw AppError.notFound('Ledger journal');
    }

    if (original.reversedByJournalId) {
      throw AppError.invalidState('Journal has already been reversed');
    }

    // Create reversal entries (swap debits and credits)
    const reversalEntries: LedgerEntry[] = original.entries.map((entry) => ({
      accountCode: entry.accountCode,
      debitCents: entry.creditCents, // Swap
      creditCents: entry.debitCents, // Swap
    }));

    return this.prisma.$transaction(async (tx) => {
      // Create the reversal journal
      const reversalJournal = await tx.ledgerJournal.create({
        data: {
          contractId: original.contractId,
          type: 'REVERSAL',
          description: `Reversal of ${journalId}: ${reason}`,
          isReversal: true,
          reversesJournalId: journalId,
          reversalReason: reason,
          createdBy,
        },
      });

      // Create reversal entries
      const entries = [];
      for (const entry of reversalEntries) {
        const currentBalance = await this.getAccountBalanceInternal(tx, entry.accountCode);

        const account = await tx.ledgerAccount.findUnique({
          where: { code: entry.accountCode },
        });

        let newBalance: number;
        if (account?.type === 'ASSET' || account?.type === 'EXPENSE') {
          newBalance = currentBalance + entry.debitCents - entry.creditCents;
        } else {
          newBalance = currentBalance + entry.creditCents - entry.debitCents;
        }

        const createdEntry = await tx.ledgerEntry.create({
          data: {
            journalId: reversalJournal.id,
            accountCode: entry.accountCode,
            debitCents: entry.debitCents,
            creditCents: entry.creditCents,
            balanceAfterCents: newBalance,
          },
        });

        entries.push(createdEntry);
      }

      // Mark original as reversed
      await tx.ledgerJournal.update({
        where: { id: journalId },
        data: { reversedByJournalId: reversalJournal.id },
      });

      return {
        id: reversalJournal.id,
        contractId: reversalJournal.contractId,
        type: reversalJournal.type,
        description: reversalJournal.description,
        isReversal: true,
        reversesJournalId: journalId,
        reversedByJournalId: null,
        createdAt: reversalJournal.createdAt,
        entries,
      };
    });
  }

  // ============================================================================
  // Balance Queries
  // ============================================================================

  /**
   * Get the current balance for an account.
   */
  async getAccountBalance(accountCode: string): Promise<number> {
    return this.getAccountBalanceInternal(this.prisma, accountCode);
  }

  /**
   * Get balances for all accounts.
   */
  async getAllAccountBalances(): Promise<AccountBalance[]> {
    const accounts = await this.prisma.ledgerAccount.findMany({
      orderBy: { code: 'asc' },
    });

    const balances: AccountBalance[] = [];

    for (const account of accounts) {
      const lastEntry = await this.prisma.ledgerEntry.findFirst({
        where: { accountCode: account.code },
        orderBy: { createdAt: 'desc' },
      });

      const balance = lastEntry?.balanceAfterCents ?? 0;

      // Calculate debit/credit representation
      let debitBalance = 0;
      let creditBalance = 0;

      if (account.type === 'ASSET' || account.type === 'EXPENSE') {
        if (balance >= 0) {
          debitBalance = balance;
        } else {
          creditBalance = Math.abs(balance);
        }
      } else {
        if (balance >= 0) {
          creditBalance = balance;
        } else {
          debitBalance = Math.abs(balance);
        }
      }

      balances.push({
        accountCode: account.code,
        accountName: account.name,
        debitBalance,
        creditBalance,
        netBalance: balance,
      });
    }

    return balances;
  }

  /**
   * Get loan-specific balances (principal, interest, fees) for a contract.
   */
  async getLoanBalances(contractId: string): Promise<LoanBalances> {
    const [principal, interest, fees] = await Promise.all([
      this.getContractAccountBalance(contractId, AccountCodes.LOANS_PRINCIPAL),
      this.getContractAccountBalance(contractId, AccountCodes.LOANS_INTEREST),
      this.getContractAccountBalance(contractId, AccountCodes.LOANS_FEES),
    ]);

    return {
      principalBalance: principal,
      interestBalance: interest,
      feesBalance: fees,
      totalBalance: principal + interest + fees,
    };
  }

  /**
   * Get balance for a specific account scoped to a contract.
   */
  async getContractAccountBalance(contractId: string, accountCode: string): Promise<number> {
    const result = await this.prisma.ledgerEntry.aggregate({
      where: {
        accountCode,
        journal: { contractId },
      },
      _sum: {
        debitCents: true,
        creditCents: true,
      },
    });

    const debits = result._sum.debitCents ?? 0;
    const credits = result._sum.creditCents ?? 0;

    // For asset accounts, balance = debits - credits
    return debits - credits;
  }

  // ============================================================================
  // Transaction Templates
  // ============================================================================

  /**
   * Record a loan disbursement.
   *
   * If from prefund:
   *   DR Loans Receivable:Principal    (increase asset - loan to borrower)
   *   CR Prefund Balances              (decrease liability - lender's prefund)
   *   DR Prefund Balances              (for express fee if any)
   *   CR Revenue:Express Fee           (recognize fee revenue)
   *
   * If direct (not from prefund):
   *   DR Loans Receivable:Principal    (increase asset - loan to borrower)
   *   CR Cash:Operating                (decrease asset - cash out)
   *   DR Cash:Operating                (express fee received)
   *   CR Revenue:Express Fee           (recognize fee revenue)
   */
  async recordDisbursement(input: DisbursementInput): Promise<JournalWithEntries> {
    const entries: LedgerEntry[] = [];

    if (input.fromPrefund) {
      // Principal from prefund
      entries.push({
        accountCode: AccountCodes.LOANS_PRINCIPAL,
        debitCents: input.principalCents,
        creditCents: 0,
      });
      entries.push({
        accountCode: AccountCodes.PREFUND_BALANCES,
        debitCents: input.principalCents, // Decrease liability
        creditCents: 0,
      });

      // Express fee (if any) - waived when from prefund typically, but record if present
      if (input.expressFeeCents > 0) {
        entries.push({
          accountCode: AccountCodes.CASH_OPERATING,
          debitCents: input.expressFeeCents,
          creditCents: 0,
        });
        entries.push({
          accountCode: AccountCodes.FEE_EXPRESS,
          debitCents: 0,
          creditCents: input.expressFeeCents,
        });
      }
    } else {
      // Direct disbursement
      entries.push({
        accountCode: AccountCodes.LOANS_PRINCIPAL,
        debitCents: input.principalCents,
        creditCents: 0,
      });
      entries.push({
        accountCode: AccountCodes.CASH_OPERATING,
        debitCents: 0,
        creditCents: input.principalCents,
      });

      // Express fee
      if (input.expressFeeCents > 0) {
        entries.push({
          accountCode: AccountCodes.CASH_OPERATING,
          debitCents: input.expressFeeCents,
          creditCents: 0,
        });
        entries.push({
          accountCode: AccountCodes.FEE_EXPRESS,
          debitCents: 0,
          creditCents: input.expressFeeCents,
        });
      }
    }

    return this.createJournal({
      contractId: input.contractId,
      type: 'DISBURSEMENT',
      description: `Disbursement of $${(input.principalCents / 100).toFixed(2)}${input.fromPrefund ? ' from prefund' : ''}`,
      entries,
      createdBy: input.createdBy,
    });
  }

  /**
   * Record a loan repayment.
   * Payment is applied according to waterfall (fees → interest → principal).
   *
   *   DR Cash:Operating                (increase asset - cash in)
   *   CR Loans Receivable:Fees         (decrease asset - fees paid)
   *   CR Loans Receivable:Interest     (decrease asset - interest paid)
   *   CR Loans Receivable:Principal    (decrease asset - principal paid)
   */
  async recordRepayment(input: RepaymentInput): Promise<JournalWithEntries> {
    const entries: LedgerEntry[] = [];

    // Cash received
    entries.push({
      accountCode: AccountCodes.CASH_OPERATING,
      debitCents: input.totalCents,
      creditCents: 0,
    });

    // Apply to fees first
    if (input.feesCents > 0) {
      entries.push({
        accountCode: AccountCodes.LOANS_FEES,
        debitCents: 0,
        creditCents: input.feesCents,
      });
    }

    // Then interest
    if (input.interestCents > 0) {
      entries.push({
        accountCode: AccountCodes.LOANS_INTEREST,
        debitCents: 0,
        creditCents: input.interestCents,
      });
    }

    // Then principal
    if (input.principalCents > 0) {
      entries.push({
        accountCode: AccountCodes.LOANS_PRINCIPAL,
        debitCents: 0,
        creditCents: input.principalCents,
      });
    }

    return this.createJournal({
      contractId: input.contractId,
      type: 'REPAYMENT',
      description: `Repayment of $${(input.totalCents / 100).toFixed(2)} (P: $${(input.principalCents / 100).toFixed(2)}, I: $${(input.interestCents / 100).toFixed(2)}, F: $${(input.feesCents / 100).toFixed(2)})`,
      entries,
      createdBy: input.createdBy,
    });
  }

  /**
   * Record a fee assessment (late fee, NSF fee, etc.).
   *
   *   DR Loans Receivable:Fees         (increase asset - borrower owes fee)
   *   CR Revenue:Fees:{type}           (recognize fee revenue)
   */
  async recordFeeAssessment(input: FeeAssessmentInput): Promise<JournalWithEntries> {
    const feeAccountMap = {
      late: AccountCodes.FEE_LATE,
      nsf: AccountCodes.FEE_NSF,
      express: AccountCodes.FEE_EXPRESS,
    };

    const entries: LedgerEntry[] = [
      {
        accountCode: AccountCodes.LOANS_FEES,
        debitCents: input.amountCents,
        creditCents: 0,
      },
      {
        accountCode: feeAccountMap[input.feeType],
        debitCents: 0,
        creditCents: input.amountCents,
      },
    ];

    return this.createJournal({
      contractId: input.contractId,
      type: 'FEE_ASSESSMENT',
      description: input.description,
      entries,
      createdBy: input.createdBy,
    });
  }

  /**
   * Record interest accrual.
   *
   *   DR Loans Receivable:Interest     (increase asset - borrower owes interest)
   *   CR Revenue:Interest Income       (recognize interest revenue)
   */
  async recordInterestAccrual(input: InterestAccrualInput): Promise<JournalWithEntries> {
    const entries: LedgerEntry[] = [
      {
        accountCode: AccountCodes.LOANS_INTEREST,
        debitCents: input.amountCents,
        creditCents: 0,
      },
      {
        accountCode: AccountCodes.INTEREST_INCOME,
        debitCents: 0,
        creditCents: input.amountCents,
      },
    ];

    const periodStr = `${input.periodStart.toISOString().split('T')[0]} to ${input.periodEnd.toISOString().split('T')[0]}`;

    return this.createJournal({
      contractId: input.contractId,
      type: 'INTEREST_ACCRUAL',
      description: `Interest accrual $${(input.amountCents / 100).toFixed(2)} for ${periodStr}`,
      entries,
      createdBy: input.createdBy,
    });
  }

  /**
   * Record a prefund deposit.
   *
   *   DR Cash:Prefund                  (increase asset - cash received)
   *   CR Prefund Balances              (increase liability - owed to lender)
   */
  async recordPrefundDeposit(
    customerId: string,
    amountCents: number,
    createdBy?: string
  ): Promise<JournalWithEntries> {
    const entries: LedgerEntry[] = [
      {
        accountCode: AccountCodes.CASH_PREFUND,
        debitCents: amountCents,
        creditCents: 0,
      },
      {
        accountCode: AccountCodes.PREFUND_BALANCES,
        debitCents: 0,
        creditCents: amountCents,
      },
    ];

    return this.createJournal({
      type: 'ADJUSTMENT',
      description: `Prefund deposit $${(amountCents / 100).toFixed(2)} for customer ${customerId}`,
      entries,
      createdBy,
    });
  }

  /**
   * Record a prefund withdrawal.
   *
   *   DR Prefund Balances              (decrease liability - lender withdrew)
   *   CR Cash:Prefund                  (decrease asset - cash out)
   */
  async recordPrefundWithdrawal(
    customerId: string,
    amountCents: number,
    createdBy?: string
  ): Promise<JournalWithEntries> {
    const entries: LedgerEntry[] = [
      {
        accountCode: AccountCodes.PREFUND_BALANCES,
        debitCents: amountCents,
        creditCents: 0,
      },
      {
        accountCode: AccountCodes.CASH_PREFUND,
        debitCents: 0,
        creditCents: amountCents,
      },
    ];

    return this.createJournal({
      type: 'ADJUSTMENT',
      description: `Prefund withdrawal $${(amountCents / 100).toFixed(2)} for customer ${customerId}`,
      entries,
      createdBy,
    });
  }

  /**
   * Record a loan write-off (bad debt).
   *
   *   DR Bad Debt Expense              (increase expense)
   *   CR Loans Receivable:Principal    (decrease asset)
   *   CR Loans Receivable:Interest     (decrease asset)
   *   CR Loans Receivable:Fees         (decrease asset)
   */
  async recordWriteOff(input: WriteOffInput): Promise<JournalWithEntries> {
    const totalWriteOff = input.principalCents + input.interestCents + input.feesCents;

    const entries: LedgerEntry[] = [
      {
        accountCode: AccountCodes.BAD_DEBT,
        debitCents: totalWriteOff,
        creditCents: 0,
      },
    ];

    if (input.principalCents > 0) {
      entries.push({
        accountCode: AccountCodes.LOANS_PRINCIPAL,
        debitCents: 0,
        creditCents: input.principalCents,
      });
    }

    if (input.interestCents > 0) {
      entries.push({
        accountCode: AccountCodes.LOANS_INTEREST,
        debitCents: 0,
        creditCents: input.interestCents,
      });
    }

    if (input.feesCents > 0) {
      entries.push({
        accountCode: AccountCodes.LOANS_FEES,
        debitCents: 0,
        creditCents: input.feesCents,
      });
    }

    return this.createJournal({
      contractId: input.contractId,
      type: 'ADJUSTMENT',
      description: `Write-off: ${input.reason}`,
      entries,
      createdBy: input.createdBy,
    });
  }

  // ============================================================================
  // Validation & Helpers
  // ============================================================================

  /**
   * Validate that total debits equal total credits.
   */
  private validateBalance(entries: LedgerEntry[]): void {
    const totalDebits = entries.reduce((sum, e) => sum + e.debitCents, 0);
    const totalCredits = entries.reduce((sum, e) => sum + e.creditCents, 0);

    if (totalDebits !== totalCredits) {
      throw AppError.invalidRequest(
        `Journal is not balanced: debits (${totalDebits}) != credits (${totalCredits})`,
        { totalDebits, totalCredits, difference: totalDebits - totalCredits }
      );
    }

    // Validate each entry has either debit or credit, not both
    for (const entry of entries) {
      if (entry.debitCents > 0 && entry.creditCents > 0) {
        throw AppError.invalidRequest(
          `Entry for ${entry.accountCode} has both debit and credit`,
          { entry }
        );
      }
      if (entry.debitCents === 0 && entry.creditCents === 0) {
        throw AppError.invalidRequest(
          `Entry for ${entry.accountCode} has no debit or credit`,
          { entry }
        );
      }
      if (entry.debitCents < 0 || entry.creditCents < 0) {
        throw AppError.invalidRequest(
          `Entry for ${entry.accountCode} has negative amount`,
          { entry }
        );
      }
    }
  }

  /**
   * Validate that all account codes exist.
   */
  private async validateAccountCodes(codes: string[]): Promise<void> {
    const uniqueCodes = [...new Set(codes)];
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: { code: { in: uniqueCodes } },
      select: { code: true },
    });

    const existingCodes = new Set(accounts.map((a) => a.code));
    const missingCodes = uniqueCodes.filter((c) => !existingCodes.has(c));

    if (missingCodes.length > 0) {
      throw AppError.invalidRequest(
        `Unknown account codes: ${missingCodes.join(', ')}`,
        { missingCodes }
      );
    }
  }

  /**
   * Get account balance using a transaction client.
   */
  private async getAccountBalanceInternal(
    tx: Prisma.TransactionClient | PrismaClient,
    accountCode: string
  ): Promise<number> {
    const lastEntry = await tx.ledgerEntry.findFirst({
      where: { accountCode },
      orderBy: { createdAt: 'desc' },
    });

    return lastEntry?.balanceAfterCents ?? 0;
  }

  // ============================================================================
  // Reporting
  // ============================================================================

  /**
   * Generate a trial balance (all accounts with their balances).
   */
  async getTrialBalance(): Promise<{
    accounts: AccountBalance[];
    totalDebits: number;
    totalCredits: number;
    isBalanced: boolean;
  }> {
    const accounts = await this.getAllAccountBalances();

    const totalDebits = accounts.reduce((sum, a) => sum + a.debitBalance, 0);
    const totalCredits = accounts.reduce((sum, a) => sum + a.creditBalance, 0);

    return {
      accounts,
      totalDebits,
      totalCredits,
      isBalanced: totalDebits === totalCredits,
    };
  }

  /**
   * Get journal history for a contract.
   */
  async getContractJournals(
    contractId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<JournalWithEntries[]> {
    const journals = await this.prisma.ledgerJournal.findMany({
      where: { contractId },
      include: { entries: true },
      orderBy: { createdAt: 'desc' },
      take: options?.limit ?? 100,
      skip: options?.offset ?? 0,
    });

    return journals.map((j) => ({
      id: j.id,
      contractId: j.contractId,
      type: j.type,
      description: j.description,
      isReversal: j.isReversal,
      reversesJournalId: j.reversesJournalId,
      reversedByJournalId: j.reversedByJournalId,
      createdAt: j.createdAt,
      entries: j.entries,
    }));
  }
}

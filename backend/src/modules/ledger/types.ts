import { JournalType } from '@prisma/client';

// ============================================================================
// Core Types
// ============================================================================

export interface LedgerEntry {
  accountCode: string;
  debitCents: number;
  creditCents: number;
}

export interface CreateJournalInput {
  contractId?: string;
  type: JournalType;
  description: string;
  entries: LedgerEntry[];
  createdBy?: string;
}

export interface AccountBalance {
  accountCode: string;
  accountName: string;
  debitBalance: number;
  creditBalance: number;
  netBalance: number;
}

export interface LoanBalances {
  principalBalance: number;
  interestBalance: number;
  feesBalance: number;
  totalBalance: number;
}

export interface JournalWithEntries {
  id: string;
  contractId: string | null;
  type: JournalType;
  description: string;
  isReversal: boolean;
  reversesJournalId: string | null;
  reversedByJournalId: string | null;
  createdAt: Date;
  entries: Array<{
    id: string;
    accountCode: string;
    debitCents: number;
    creditCents: number;
    balanceAfterCents: number;
  }>;
}

// ============================================================================
// Account Codes (Chart of Accounts)
// ============================================================================

export const AccountCodes = {
  // Assets
  CASH_OPERATING: 'assets:cash:operating',
  CASH_PREFUND: 'assets:cash:prefund',
  LOANS_PRINCIPAL: 'assets:loans_receivable:principal',
  LOANS_INTEREST: 'assets:loans_receivable:interest',
  LOANS_FEES: 'assets:loans_receivable:fees',

  // Liabilities
  PREFUND_BALANCES: 'liabilities:prefund_balances',
  PENDING_DISBURSEMENTS: 'liabilities:pending_disbursements',
  PENDING_SETTLEMENTS: 'liabilities:pending_settlements',

  // Revenue
  INTEREST_INCOME: 'revenue:interest_income',
  FEE_EXPRESS: 'revenue:fees:express_disbursement',
  FEE_LATE: 'revenue:fees:late_payment',
  FEE_NSF: 'revenue:fees:nsf',

  // Expenses
  PAYMENT_PROCESSING: 'expenses:payment_processing',
  BAD_DEBT: 'expenses:bad_debt',
} as const;

export type AccountCode = typeof AccountCodes[keyof typeof AccountCodes];

// ============================================================================
// Transaction Templates Input Types
// ============================================================================

export interface DisbursementInput {
  contractId: string;
  principalCents: number;
  expressFeeCents: number;
  fromPrefund: boolean;
  lenderId: string;
  createdBy?: string;
}

export interface RepaymentInput {
  contractId: string;
  totalCents: number;
  principalCents: number;
  interestCents: number;
  feesCents: number;
  createdBy?: string;
}

export interface FeeAssessmentInput {
  contractId: string;
  feeType: 'late' | 'nsf' | 'express';
  amountCents: number;
  description: string;
  createdBy?: string;
}

export interface InterestAccrualInput {
  contractId: string;
  amountCents: number;
  periodStart: Date;
  periodEnd: Date;
  createdBy?: string;
}

export interface WriteOffInput {
  contractId: string;
  principalCents: number;
  interestCents: number;
  feesCents: number;
  reason: string;
  createdBy?: string;
}

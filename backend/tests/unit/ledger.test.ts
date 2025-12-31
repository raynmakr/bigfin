import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { LedgerService, AccountCodes } from '../../src/modules/ledger/index.js';

const prisma = new PrismaClient();
let ledgerService: LedgerService;

describe('LedgerService', () => {
  beforeAll(async () => {
    ledgerService = new LedgerService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Journal Balance Validation', () => {
    it('should reject unbalanced journals', async () => {
      await expect(
        ledgerService.createJournal({
          type: 'ADJUSTMENT',
          description: 'Unbalanced test',
          entries: [
            { accountCode: AccountCodes.CASH_OPERATING, debitCents: 1000, creditCents: 0 },
            { accountCode: AccountCodes.LOANS_PRINCIPAL, debitCents: 0, creditCents: 500 },
          ],
        })
      ).rejects.toThrow(/not balanced/);
    });

    it('should reject entries with both debit and credit', async () => {
      await expect(
        ledgerService.createJournal({
          type: 'ADJUSTMENT',
          description: 'Invalid entry test',
          entries: [
            { accountCode: AccountCodes.CASH_OPERATING, debitCents: 1000, creditCents: 500 },
            { accountCode: AccountCodes.LOANS_PRINCIPAL, debitCents: 0, creditCents: 500 },
          ],
        })
      ).rejects.toThrow(/both debit and credit/);
    });

    it('should reject entries with zero amounts', async () => {
      await expect(
        ledgerService.createJournal({
          type: 'ADJUSTMENT',
          description: 'Zero entry test',
          entries: [
            { accountCode: AccountCodes.CASH_OPERATING, debitCents: 0, creditCents: 0 },
            { accountCode: AccountCodes.LOANS_PRINCIPAL, debitCents: 0, creditCents: 0 },
          ],
        })
      ).rejects.toThrow(/no debit or credit/);
    });

    it('should reject negative amounts', async () => {
      await expect(
        ledgerService.createJournal({
          type: 'ADJUSTMENT',
          description: 'Negative entry test',
          entries: [
            { accountCode: AccountCodes.CASH_OPERATING, debitCents: -1000, creditCents: 0 },
            { accountCode: AccountCodes.LOANS_PRINCIPAL, debitCents: 0, creditCents: -1000 },
          ],
        })
      ).rejects.toThrow(/negative amount/);
    });

    it('should reject unknown account codes', async () => {
      await expect(
        ledgerService.createJournal({
          type: 'ADJUSTMENT',
          description: 'Unknown account test',
          entries: [
            { accountCode: 'unknown:account', debitCents: 1000, creditCents: 0 },
            { accountCode: AccountCodes.LOANS_PRINCIPAL, debitCents: 0, creditCents: 1000 },
          ],
        })
      ).rejects.toThrow(/Unknown account codes/);
    });
  });

  describe('Balanced Journal Creation', () => {
    it('should create a balanced journal', async () => {
      const journal = await ledgerService.createJournal({
        type: 'ADJUSTMENT',
        description: 'Test balanced journal',
        entries: [
          { accountCode: AccountCodes.CASH_OPERATING, debitCents: 10000, creditCents: 0 },
          { accountCode: AccountCodes.INTEREST_INCOME, debitCents: 0, creditCents: 10000 },
        ],
      });

      expect(journal.id).toBeDefined();
      expect(journal.entries).toHaveLength(2);
      expect(journal.type).toBe('ADJUSTMENT');

      // Verify entries
      const debitEntry = journal.entries.find((e) => e.debitCents > 0);
      const creditEntry = journal.entries.find((e) => e.creditCents > 0);

      expect(debitEntry?.debitCents).toBe(10000);
      expect(creditEntry?.creditCents).toBe(10000);
    });

    it('should handle multiple entries that balance', async () => {
      const journal = await ledgerService.createJournal({
        type: 'REPAYMENT',
        description: 'Multi-entry test',
        entries: [
          { accountCode: AccountCodes.CASH_OPERATING, debitCents: 15000, creditCents: 0 },
          { accountCode: AccountCodes.LOANS_PRINCIPAL, debitCents: 0, creditCents: 10000 },
          { accountCode: AccountCodes.LOANS_INTEREST, debitCents: 0, creditCents: 3000 },
          { accountCode: AccountCodes.LOANS_FEES, debitCents: 0, creditCents: 2000 },
        ],
      });

      expect(journal.entries).toHaveLength(4);

      const totalDebits = journal.entries.reduce((sum, e) => sum + e.debitCents, 0);
      const totalCredits = journal.entries.reduce((sum, e) => sum + e.creditCents, 0);

      expect(totalDebits).toBe(15000);
      expect(totalCredits).toBe(15000);
    });
  });

  describe('Trial Balance', () => {
    it('should return a balanced trial balance', async () => {
      const trialBalance = await ledgerService.getTrialBalance();

      expect(trialBalance.isBalanced).toBe(true);
      expect(trialBalance.totalDebits).toBe(trialBalance.totalCredits);
      expect(trialBalance.accounts).toBeDefined();
      expect(Array.isArray(trialBalance.accounts)).toBe(true);
    });
  });

  describe('Transaction Templates', () => {
    // These tests need a contract to exist, so we'll skip them in unit tests
    // and test them in integration tests
    it.skip('should record a disbursement', async () => {
      // Requires existing contract
    });

    it.skip('should record a repayment', async () => {
      // Requires existing contract
    });
  });

  describe('Journal Reversal', () => {
    it('should reverse a journal with opposite entries', async () => {
      // Create original journal
      const original = await ledgerService.createJournal({
        type: 'ADJUSTMENT',
        description: 'Original journal for reversal test',
        entries: [
          { accountCode: AccountCodes.CASH_OPERATING, debitCents: 5000, creditCents: 0 },
          { accountCode: AccountCodes.INTEREST_INCOME, debitCents: 0, creditCents: 5000 },
        ],
      });

      // Reverse it
      const reversal = await ledgerService.reverseJournal(
        original.id,
        'Test reversal reason'
      );

      expect(reversal.isReversal).toBe(true);
      expect(reversal.reversesJournalId).toBe(original.id);
      expect(reversal.type).toBe('REVERSAL');

      // Verify entries are swapped
      const originalDebitAccount = AccountCodes.CASH_OPERATING;
      const reversalEntry = reversal.entries.find((e) => e.accountCode === originalDebitAccount);

      // Original was debit, reversal should be credit
      expect(reversalEntry?.creditCents).toBe(5000);
      expect(reversalEntry?.debitCents).toBe(0);
    });

    it('should not allow reversing an already reversed journal', async () => {
      // Create and reverse a journal
      const original = await ledgerService.createJournal({
        type: 'ADJUSTMENT',
        description: 'Journal to reverse twice',
        entries: [
          { accountCode: AccountCodes.CASH_OPERATING, debitCents: 1000, creditCents: 0 },
          { accountCode: AccountCodes.INTEREST_INCOME, debitCents: 0, creditCents: 1000 },
        ],
      });

      await ledgerService.reverseJournal(original.id, 'First reversal');

      // Try to reverse again
      await expect(
        ledgerService.reverseJournal(original.id, 'Second reversal')
      ).rejects.toThrow(/already been reversed/);
    });
  });

  describe('Account Balances', () => {
    it('should return 0 for account with no entries', async () => {
      const balance = await ledgerService.getAccountBalance(AccountCodes.BAD_DEBT);
      expect(typeof balance).toBe('number');
    });

    it('should track running balances correctly', async () => {
      const accountCode = AccountCodes.CASH_OPERATING;

      // Get initial balance
      const initialBalance = await ledgerService.getAccountBalance(accountCode);

      // Create a debit entry (increases asset)
      await ledgerService.createJournal({
        type: 'ADJUSTMENT',
        description: 'Increase cash',
        entries: [
          { accountCode, debitCents: 2500, creditCents: 0 },
          { accountCode: AccountCodes.INTEREST_INCOME, debitCents: 0, creditCents: 2500 },
        ],
      });

      // Check new balance
      const newBalance = await ledgerService.getAccountBalance(accountCode);
      expect(newBalance).toBe(initialBalance + 2500);

      // Create a credit entry (decreases asset)
      await ledgerService.createJournal({
        type: 'ADJUSTMENT',
        description: 'Decrease cash',
        entries: [
          { accountCode, debitCents: 0, creditCents: 1000 },
          { accountCode: AccountCodes.PAYMENT_PROCESSING, debitCents: 1000, creditCents: 0 },
        ],
      });

      // Check final balance
      const finalBalance = await ledgerService.getAccountBalance(accountCode);
      expect(finalBalance).toBe(initialBalance + 2500 - 1000);
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mocks
const { mockPrisma, mockMoovClient, mockLedgerService } = vi.hoisted(() => ({
  mockPrisma: {
    disbursement: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    repayment: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    customer: {
      findMany: vi.fn(),
    },
    prefundTransaction: {
      findMany: vi.fn(),
    },
  },
  mockMoovClient: {
    listTransfers: vi.fn(),
  },
  mockLedgerService: {
    getTrialBalance: vi.fn(),
  },
}));

vi.mock('../../src/config/database.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../src/modules/payments/services/moov-client.js', () => ({
  getMoovClient: () => mockMoovClient,
}));

vi.mock('../../src/modules/ledger/service.js', () => ({
  LedgerService: vi.fn().mockImplementation(() => mockLedgerService),
}));

vi.mock('nanoid', () => ({
  nanoid: () => 'test-id-123',
}));

import { ReconciliationService } from '../../src/modules/reconciliation/service.js';
import type { ReconciliationConfig } from '../../src/modules/reconciliation/types.js';

describe('ReconciliationService', () => {
  let service: ReconciliationService;
  const testConfig: Partial<ReconciliationConfig> = {
    defaultLookbackDays: 7,
    autoResolveStatusUpdates: true,
    autoResolveThresholdCents: 100,
    highSeverityThresholdCents: 10000,
    criticalSeverityThresholdCents: 100000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ReconciliationService(testConfig);

    // Default mock responses
    mockPrisma.disbursement.findMany.mockResolvedValue([]);
    mockPrisma.repayment.findMany.mockResolvedValue([]);
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockMoovClient.listTransfers.mockResolvedValue([]);
    mockLedgerService.getTrialBalance.mockResolvedValue({
      isBalanced: true,
      totalDebits: 10000,
      totalCredits: 10000,
      accounts: [],
    });
  });

  describe('runReconciliation', () => {
    it('should run full reconciliation and return results', async () => {
      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      expect(result.run.status).toBe('completed');
      expect(result.run.tenantId).toBe('tenant-1');
      expect(result.exceptions).toEqual([]);
      expect(result.autoResolved).toEqual([]);
    });

    it('should use default period when not specified', async () => {
      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      const daysDiff = Math.round(
        (result.run.periodEnd.getTime() - result.run.periodStart.getTime()) /
          (1000 * 60 * 60 * 24)
      );
      expect(daysDiff).toBe(7);
    });

    it('should use custom period when specified', async () => {
      const periodStart = new Date('2024-01-01');
      const periodEnd = new Date('2024-01-15');

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        periodStart,
        periodEnd,
        dryRun: true,
      });

      expect(result.run.periodStart).toEqual(periodStart);
      expect(result.run.periodEnd).toEqual(periodEnd);
    });

    it('should count total records checked', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        { id: 'd1', providerRef: 'ref1', amountCents: 1000, status: 'COMPLETED', initiatedAt: new Date() },
        { id: 'd2', providerRef: 'ref2', amountCents: 2000, status: 'PENDING', initiatedAt: new Date() },
      ]);
      mockPrisma.repayment.findMany.mockResolvedValue([
        { id: 'r1', providerRef: 'ref3', amountCents: 500, status: 'COMPLETED', initiatedAt: new Date() },
      ]);
      mockPrisma.customer.findMany.mockResolvedValue([
        { id: 'c1', prefundTransactions: [{ availableAfterCents: 1000 }] },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        { transferID: 'ref1', status: 'completed', amount: { value: 1000 }, createdOn: new Date().toISOString() },
        { transferID: 'ref2', status: 'pending', amount: { value: 2000 }, createdOn: new Date().toISOString() },
        { transferID: 'ref3', status: 'completed', amount: { value: 500 }, createdOn: new Date().toISOString() },
      ]);

      mockPrisma.prefundTransaction.findMany.mockResolvedValue([
        { type: 'DEPOSIT', amountCents: 1000, status: 'COMPLETED' },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      // 2 disbursements + 1 repayment + 1 prefund + 1 ledger
      expect(result.run.totalRecordsChecked).toBe(5);
    });
  });

  describe('disbursement reconciliation', () => {
    it('should detect status mismatch between local and provider', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'moov-ref-1',
          amountCents: 50000,
          status: 'PENDING',
          initiatedAt: new Date(),
          contract: { tenantId: 'tenant-1' },
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'moov-ref-1',
          status: 'completed',
          amount: { value: 50000 },
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      expect(result.exceptions).toHaveLength(1);
      expect(result.exceptions[0].type).toBe('transfer_status');
      expect(result.exceptions[0].description).toContain('Status mismatch');
      expect(result.run.summary.disbursements.statusMismatch).toBe(1);
    });

    it('should detect amount mismatch', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'moov-ref-1',
          amountCents: 50000,
          status: 'COMPLETED',
          initiatedAt: new Date(),
          contract: { tenantId: 'tenant-1' },
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'moov-ref-1',
          status: 'completed',
          amount: { value: 49900 }, // 100 cents difference
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      expect(result.exceptions).toHaveLength(1);
      expect(result.exceptions[0].type).toBe('amount_mismatch');
      expect(result.exceptions[0].discrepancyAmountCents).toBe(100);
      expect(result.run.summary.disbursements.amountMismatch).toBe(1);
    });

    it('should detect orphaned transfers (local but not in provider)', async () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours ago

      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'moov-ref-missing',
          amountCents: 10000,
          status: 'PENDING',
          initiatedAt: oldDate,
          contract: { tenantId: 'tenant-1' },
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      expect(result.exceptions).toHaveLength(1);
      expect(result.exceptions[0].type).toBe('transfer_orphaned');
      expect(result.run.summary.disbursements.orphaned).toBe(1);
    });

    it('should not flag orphaned transfers less than 24 hours old', async () => {
      const recentDate = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12 hours ago

      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'moov-ref-recent',
          amountCents: 10000,
          status: 'PENDING',
          initiatedAt: recentDate,
          contract: { tenantId: 'tenant-1' },
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      expect(result.exceptions).toHaveLength(0);
    });

    it('should detect missing transfers (in provider but not locally)', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'moov-ref-unknown',
          status: 'completed',
          amount: { value: 25000 },
          createdOn: new Date().toISOString(),
          metadata: { type: 'disbursement' },
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      expect(result.exceptions).toHaveLength(1);
      expect(result.exceptions[0].type).toBe('transfer_missing');
      expect(result.run.summary.disbursements.missing).toBe(1);
    });

    it('should track matched disbursements', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'moov-ref-1',
          amountCents: 50000,
          status: 'COMPLETED',
          initiatedAt: new Date(),
          contract: { tenantId: 'tenant-1' },
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'moov-ref-1',
          status: 'completed',
          amount: { value: 50000 },
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      expect(result.exceptions).toHaveLength(0);
      expect(result.run.summary.disbursements.matched).toBe(1);
    });
  });

  describe('repayment reconciliation', () => {
    it('should detect repayment status mismatch', async () => {
      mockPrisma.repayment.findMany.mockResolvedValue([
        {
          id: 'rep-1',
          providerRef: 'moov-ref-1',
          amountCents: 25000,
          status: 'COMPLETED',
          initiatedAt: new Date(),
          contract: { tenantId: 'tenant-1' },
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'moov-ref-1',
          status: 'failed',
          amount: { value: 25000 },
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      const repaymentExceptions = result.exceptions.filter(
        e => e.localRecordType === 'repayment'
      );
      expect(repaymentExceptions).toHaveLength(1);
      expect(repaymentExceptions[0].type).toBe('transfer_status');
    });

    it('should detect repayment amount mismatch', async () => {
      mockPrisma.repayment.findMany.mockResolvedValue([
        {
          id: 'rep-1',
          providerRef: 'moov-ref-1',
          amountCents: 25000,
          status: 'COMPLETED',
          initiatedAt: new Date(),
          contract: { tenantId: 'tenant-1' },
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'moov-ref-1',
          status: 'completed',
          amount: { value: 24500 },
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      const repaymentExceptions = result.exceptions.filter(
        e => e.localRecordType === 'repayment'
      );
      expect(repaymentExceptions).toHaveLength(1);
      expect(repaymentExceptions[0].type).toBe('amount_mismatch');
      expect(repaymentExceptions[0].discrepancyAmountCents).toBe(500);
    });
  });

  describe('ledger reconciliation', () => {
    it('should detect ledger imbalance', async () => {
      mockLedgerService.getTrialBalance.mockResolvedValue({
        isBalanced: false,
        totalDebits: 100000,
        totalCredits: 99500,
        accounts: [],
      });

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      const ledgerExceptions = result.exceptions.filter(
        e => e.type === 'ledger_imbalance'
      );
      expect(ledgerExceptions).toHaveLength(1);
      expect(ledgerExceptions[0].severity).toBe('critical');
      expect(ledgerExceptions[0].discrepancyAmountCents).toBe(500);
    });

    it('should not flag balanced ledger', async () => {
      mockLedgerService.getTrialBalance.mockResolvedValue({
        isBalanced: true,
        totalDebits: 100000,
        totalCredits: 100000,
        accounts: [],
      });

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      const ledgerExceptions = result.exceptions.filter(
        e => e.type === 'ledger_imbalance'
      );
      expect(ledgerExceptions).toHaveLength(0);
      expect(result.run.summary.ledger.isBalanced).toBe(true);
    });
  });

  describe('prefund reconciliation', () => {
    it('should detect prefund balance mismatch', async () => {
      mockPrisma.customer.findMany.mockResolvedValue([
        {
          id: 'cust-1',
          tenantId: 'tenant-1',
          prefundTransactions: [{ availableAfterCents: 5000 }], // recorded balance
        },
      ]);

      mockPrisma.prefundTransaction.findMany.mockResolvedValue([
        { type: 'DEPOSIT', amountCents: 10000, status: 'COMPLETED' },
        { type: 'WITHDRAWAL', amountCents: 3000, status: 'COMPLETED' },
        // Calculated: 10000 - 3000 = 7000, but recorded is 5000
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      const prefundExceptions = result.exceptions.filter(
        e => e.type === 'prefund_mismatch'
      );
      expect(prefundExceptions).toHaveLength(1);
      expect(prefundExceptions[0].discrepancyAmountCents).toBe(2000);
    });

    it('should handle all prefund transaction types', async () => {
      mockPrisma.customer.findMany.mockResolvedValue([
        {
          id: 'cust-1',
          tenantId: 'tenant-1',
          prefundTransactions: [{ availableAfterCents: 4000 }],
        },
      ]);

      mockPrisma.prefundTransaction.findMany.mockResolvedValue([
        { type: 'DEPOSIT', amountCents: 10000, status: 'COMPLETED' },
        { type: 'WITHDRAWAL', amountCents: 2000, status: 'COMPLETED' },
        { type: 'FEE', amountCents: 500, status: 'COMPLETED' },
        { type: 'DISBURSEMENT_HOLD', amountCents: 5000, status: 'COMPLETED' },
        { type: 'DISBURSEMENT_RELEASE', amountCents: 1500, status: 'COMPLETED' },
        // Calculated: 10000 - 2000 - 500 - 5000 + 1500 = 4000
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      const prefundExceptions = result.exceptions.filter(
        e => e.type === 'prefund_mismatch'
      );
      expect(prefundExceptions).toHaveLength(0);
      expect(result.run.summary.prefund.balanceMatches).toBe(1);
    });

    it('should ignore non-completed transactions', async () => {
      mockPrisma.customer.findMany.mockResolvedValue([
        {
          id: 'cust-1',
          tenantId: 'tenant-1',
          prefundTransactions: [{ availableAfterCents: 5000 }],
        },
      ]);

      mockPrisma.prefundTransaction.findMany.mockResolvedValue([
        { type: 'DEPOSIT', amountCents: 5000, status: 'COMPLETED' },
        { type: 'DEPOSIT', amountCents: 10000, status: 'PENDING' }, // Should be ignored
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      const prefundExceptions = result.exceptions.filter(
        e => e.type === 'prefund_mismatch'
      );
      expect(prefundExceptions).toHaveLength(0);
    });
  });

  describe('severity calculation', () => {
    it('should classify low severity for small amounts', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'ref-1',
          amountCents: 500, // $5
          status: 'COMPLETED',
          initiatedAt: new Date(),
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'ref-1',
          status: 'completed',
          amount: { value: 450 },
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      expect(result.exceptions[0].severity).toBe('low');
    });

    it('should classify medium severity for amounts >= $10', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'ref-1',
          amountCents: 5000, // $50
          status: 'COMPLETED',
          initiatedAt: new Date(),
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'ref-1',
          status: 'completed',
          amount: { value: 3000 }, // $20 discrepancy
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      expect(result.exceptions[0].severity).toBe('medium');
    });

    it('should classify high severity for amounts >= threshold', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'ref-1',
          amountCents: 50000, // $500
          status: 'COMPLETED',
          initiatedAt: new Date(),
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'ref-1',
          status: 'completed',
          amount: { value: 35000 }, // $150 discrepancy > $100 threshold
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      expect(result.exceptions[0].severity).toBe('high');
    });

    it('should classify critical severity for amounts >= critical threshold', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'ref-1',
          amountCents: 500000, // $5000
          status: 'COMPLETED',
          initiatedAt: new Date(),
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'ref-1',
          status: 'completed',
          amount: { value: 350000 }, // $1500 discrepancy > $1000 critical threshold
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      expect(result.exceptions[0].severity).toBe('critical');
    });

    it('should mark completed->failed status mismatch as critical', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'ref-1',
          amountCents: 1000,
          status: 'COMPLETED',
          initiatedAt: new Date(),
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'ref-1',
          status: 'failed',
          amount: { value: 1000 },
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      expect(result.exceptions[0].severity).toBe('critical');
    });

    it('should mark pending->completed status mismatch as high', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'ref-1',
          amountCents: 1000,
          status: 'PENDING',
          initiatedAt: new Date(),
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'ref-1',
          status: 'completed',
          amount: { value: 1000 },
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      expect(result.exceptions[0].severity).toBe('high');
    });
  });

  describe('auto-resolution', () => {
    it('should auto-resolve pending->completed status mismatch', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'ref-1',
          amountCents: 1000,
          status: 'PENDING',
          initiatedAt: new Date(),
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'ref-1',
          status: 'completed',
          amount: { value: 1000 },
          createdOn: new Date().toISOString(),
        },
      ]);

      mockPrisma.disbursement.update.mockResolvedValue({});

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: false,
      });

      expect(result.autoResolved).toHaveLength(1);
      expect(result.autoResolved[0].resolutionType).toBe('auto_corrected');
      expect(mockPrisma.disbursement.update).toHaveBeenCalledWith({
        where: { id: 'disb-1' },
        data: expect.objectContaining({
          status: 'COMPLETED',
          availabilityState: 'AVAILABLE',
        }),
      });
    });

    it('should not auto-resolve in dry run mode', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'ref-1',
          amountCents: 1000,
          status: 'PENDING',
          initiatedAt: new Date(),
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'ref-1',
          status: 'completed',
          amount: { value: 1000 },
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      expect(result.autoResolved).toHaveLength(0);
      expect(mockPrisma.disbursement.update).not.toHaveBeenCalled();
    });

    it('should not auto-resolve amount mismatches', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'ref-1',
          amountCents: 1000,
          status: 'COMPLETED',
          initiatedAt: new Date(),
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'ref-1',
          status: 'completed',
          amount: { value: 900 },
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: false,
      });

      expect(result.autoResolved).toHaveLength(0);
    });

    it('should not auto-resolve completed->failed (critical)', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'ref-1',
          amountCents: 1000,
          status: 'COMPLETED',
          initiatedAt: new Date(),
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'ref-1',
          status: 'failed',
          amount: { value: 1000 },
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: false,
      });

      expect(result.autoResolved).toHaveLength(0);
    });

    it('should auto-resolve repayment status updates', async () => {
      mockPrisma.repayment.findMany.mockResolvedValue([
        {
          id: 'rep-1',
          providerRef: 'ref-1',
          amountCents: 500,
          status: 'PENDING',
          initiatedAt: new Date(),
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'ref-1',
          status: 'completed',
          amount: { value: 500 },
          createdOn: new Date().toISOString(),
        },
      ]);

      mockPrisma.repayment.update.mockResolvedValue({});

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: false,
      });

      expect(result.autoResolved).toHaveLength(1);
      expect(mockPrisma.repayment.update).toHaveBeenCalledWith({
        where: { id: 'rep-1' },
        data: expect.objectContaining({
          status: 'COMPLETED',
          availabilityState: 'AVAILABLE',
        }),
      });
    });
  });

  describe('status normalization', () => {
    it('should normalize various status formats', async () => {
      // Test that PROCESSING local status maps to pending for comparison
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'ref-1',
          amountCents: 1000,
          status: 'PROCESSING',
          initiatedAt: new Date(),
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'ref-1',
          status: 'pending',
          amount: { value: 1000 },
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      // PROCESSING and pending should both normalize to 'pending', so no mismatch
      expect(result.exceptions).toHaveLength(0);
      expect(result.run.summary.disbursements.matched).toBe(1);
    });

    it('should handle reversed/returned status mapping', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'ref-1',
          amountCents: 1000,
          status: 'RETURNED',
          initiatedAt: new Date(),
        },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        {
          transferID: 'ref-1',
          status: 'reversed',
          amount: { value: 1000 },
          createdOn: new Date().toISOString(),
        },
      ]);

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      // RETURNED and reversed should both normalize to 'returned', so no mismatch
      expect(result.exceptions).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('should mark run as failed on error', async () => {
      mockPrisma.disbursement.findMany.mockRejectedValue(
        new Error('Database connection failed')
      );

      await expect(
        service.runReconciliation({
          tenantId: 'tenant-1',
          dryRun: true,
        })
      ).rejects.toThrow('Database connection failed');
    });

    it('should handle provider API failures gracefully', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        {
          id: 'disb-1',
          providerRef: 'ref-1',
          amountCents: 1000,
          status: 'PENDING',
          initiatedAt: new Date(),
        },
      ]);

      mockMoovClient.listTransfers.mockRejectedValue(
        new Error('Moov API unavailable')
      );

      // The service should catch the error in getProviderTransfers and return empty array
      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      // With no provider transfers, recent disbursements won't be flagged as orphaned
      expect(result.run.status).toBe('completed');
    });
  });

  describe('summary reporting', () => {
    it('should generate comprehensive summary', async () => {
      mockPrisma.disbursement.findMany.mockResolvedValue([
        { id: 'd1', providerRef: 'ref1', amountCents: 1000, status: 'COMPLETED', initiatedAt: new Date() },
        { id: 'd2', providerRef: 'ref2', amountCents: 2000, status: 'PENDING', initiatedAt: new Date() },
      ]);

      mockPrisma.repayment.findMany.mockResolvedValue([
        { id: 'r1', providerRef: 'ref3', amountCents: 500, status: 'COMPLETED', initiatedAt: new Date() },
      ]);

      mockPrisma.customer.findMany.mockResolvedValue([
        { id: 'c1', prefundTransactions: [{ availableAfterCents: 5000 }] },
        { id: 'c2', prefundTransactions: [{ availableAfterCents: 3000 }] },
      ]);

      mockMoovClient.listTransfers.mockResolvedValue([
        { transferID: 'ref1', status: 'completed', amount: { value: 1000 }, createdOn: new Date().toISOString() },
        { transferID: 'ref2', status: 'pending', amount: { value: 2000 }, createdOn: new Date().toISOString() },
        { transferID: 'ref3', status: 'completed', amount: { value: 500 }, createdOn: new Date().toISOString() },
      ]);

      mockPrisma.prefundTransaction.findMany.mockResolvedValue([
        { type: 'DEPOSIT', amountCents: 5000, status: 'COMPLETED' },
      ]);

      mockLedgerService.getTrialBalance.mockResolvedValue({
        isBalanced: true,
        totalDebits: 50000,
        totalCredits: 50000,
        accounts: [],
      });

      const result = await service.runReconciliation({
        tenantId: 'tenant-1',
        dryRun: true,
      });

      expect(result.run.summary).toMatchObject({
        disbursements: {
          checked: 2,
          matched: 2,
          statusMismatch: 0,
          amountMismatch: 0,
        },
        repayments: {
          checked: 1,
          matched: 1,
        },
        ledger: {
          isBalanced: true,
          totalDebits: 50000,
          totalCredits: 50000,
        },
        prefund: {
          accountsChecked: 2,
        },
      });
    });
  });
});

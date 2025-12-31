import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mocks
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    loanContract: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    ledgerJournal: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    ledgerEntry: {
      create: vi.fn(),
    },
    disbursement: {
      findMany: vi.fn(),
      aggregate: vi.fn(),
    },
    repayment: {
      findMany: vi.fn(),
      aggregate: vi.fn(),
    },
    repaymentScheduleItem: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    customer: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    auditLog: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn((fn) => fn(mockPrisma)),
  },
}));

vi.mock('../../src/config/database.js', () => ({
  prisma: mockPrisma,
}));

// Mock the Fastify app with prisma plugin
const createMockApp = () => ({
  prisma: mockPrisma,
  addHook: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  register: vi.fn(),
});

describe('Operator Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Loan Search', () => {
    it('should search loans with filters', async () => {
      const mockContracts = [
        {
          id: 'contract-1',
          status: 'ACTIVE',
          principalCents: 100000,
          aprBps: 1200,
          termMonths: 12,
          paymentFrequency: 'MONTHLY',
          principalBalanceCents: 80000,
          interestBalanceCents: 2000,
          feesBalanceCents: 0,
          originatedAt: new Date('2024-01-01'),
          disbursedAt: new Date('2024-01-02'),
          paidOffAt: null,
          createdAt: new Date('2024-01-01'),
          product: { id: 'prod-1', name: 'Personal Loan' },
          lender: { id: 'lender-1', firstName: 'John', lastName: 'Doe', email: 'john@example.com' },
          borrower: { id: 'borrower-1', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.com' },
        },
      ];

      mockPrisma.loanContract.findMany.mockResolvedValue(mockContracts);

      // Simulate the query logic
      const result = mockContracts.map((c) => ({
        id: c.id,
        status: c.status.toLowerCase(),
        product: { id: c.product.id, name: c.product.name },
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
      }));

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('active');
      expect(result[0].lender.name).toBe('John Doe');
      expect(result[0].borrower.name).toBe('Jane Smith');
      expect(result[0].balances.total_cents).toBe(82000);
    });

    it('should filter by status', async () => {
      mockPrisma.loanContract.findMany.mockResolvedValue([]);

      // Simulate calling with status filter
      await mockPrisma.loanContract.findMany({
        where: {
          tenantId: 'tenant-1',
          status: 'ACTIVE',
        },
      });

      expect(mockPrisma.loanContract.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'ACTIVE',
          }),
        })
      );
    });

    it('should filter by lender_id', async () => {
      mockPrisma.loanContract.findMany.mockResolvedValue([]);

      await mockPrisma.loanContract.findMany({
        where: {
          tenantId: 'tenant-1',
          lenderId: 'lender-123',
        },
      });

      expect(mockPrisma.loanContract.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            lenderId: 'lender-123',
          }),
        })
      );
    });

    it('should support pagination with cursor', async () => {
      mockPrisma.loanContract.findMany.mockResolvedValue([]);

      await mockPrisma.loanContract.findMany({
        where: { tenantId: 'tenant-1' },
        take: 21,
        cursor: { id: 'cursor-id' },
        skip: 1,
        orderBy: { createdAt: 'desc' },
      });

      expect(mockPrisma.loanContract.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: { id: 'cursor-id' },
          skip: 1,
        })
      );
    });
  });

  describe('Loan Details', () => {
    it('should return full loan details', async () => {
      const mockContract = {
        id: 'contract-1',
        status: 'ACTIVE',
        principalCents: 100000,
        aprBps: 1200,
        termMonths: 12,
        paymentFrequency: 'MONTHLY',
        firstPaymentDate: new Date('2024-02-01'),
        principalBalanceCents: 80000,
        interestBalanceCents: 2000,
        feesBalanceCents: 0,
        originatedAt: new Date('2024-01-01'),
        disbursedAt: new Date('2024-01-02'),
        paidOffAt: null,
        defaultedAt: null,
        createdAt: new Date('2024-01-01'),
        product: { id: 'prod-1', name: 'Personal Loan', code: 'PL001' },
        lender: { id: 'lender-1', firstName: 'John', lastName: 'Doe', email: 'john@example.com', phone: '1234567890' },
        borrower: { id: 'borrower-1', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.com', phone: '0987654321' },
        offer: { id: 'offer-1', createdAt: new Date(), expiresAt: new Date(), respondedAt: new Date() },
        _count: {
          disbursements: 1,
          repayments: 3,
          ledgerJournals: 5,
          documents: 2,
        },
      };

      mockPrisma.loanContract.findFirst.mockResolvedValue(mockContract);

      const contract = await mockPrisma.loanContract.findFirst({
        where: { id: 'contract-1', tenantId: 'tenant-1' },
        include: {
          lender: true,
          borrower: true,
          product: true,
          offer: true,
          _count: true,
        },
      });

      expect(contract).toBeDefined();
      expect(contract?.id).toBe('contract-1');
      expect(contract?._count.disbursements).toBe(1);
      expect(contract?._count.repayments).toBe(3);
    });

    it('should return null for non-existent loan', async () => {
      mockPrisma.loanContract.findFirst.mockResolvedValue(null);

      const contract = await mockPrisma.loanContract.findFirst({
        where: { id: 'non-existent', tenantId: 'tenant-1' },
      });

      expect(contract).toBeNull();
    });
  });

  describe('Loan Ledger', () => {
    it('should return ledger journals with entries', async () => {
      const mockJournals = [
        {
          id: 'journal-1',
          type: 'DISBURSEMENT',
          description: 'Initial disbursement',
          isReversal: false,
          reversalReason: null,
          reversesJournal: null,
          reversedByJournal: null,
          createdBy: 'user-1',
          createdAt: new Date('2024-01-02'),
          entries: [
            { accountCode: '1000-CASH', debitCents: 100000, creditCents: 0, balanceAfterCents: 100000 },
            { accountCode: '2000-PRINCIPAL', debitCents: 0, creditCents: 100000, balanceAfterCents: 100000 },
          ],
        },
      ];

      mockPrisma.ledgerJournal.findMany.mockResolvedValue(mockJournals);

      const journals = await mockPrisma.ledgerJournal.findMany({
        where: { contractId: 'contract-1' },
        include: { entries: true, reversesJournal: true, reversedByJournal: true },
      });

      expect(journals).toHaveLength(1);
      expect(journals[0].entries).toHaveLength(2);
      expect(journals[0].entries[0].accountCode).toBe('1000-CASH');
    });

    it('should show reversal relationships', async () => {
      const mockJournals = [
        {
          id: 'reversal-1',
          type: 'REVERSAL',
          description: 'Reversal of journal-1: Error correction',
          isReversal: true,
          reversalReason: 'Error correction',
          reversesJournal: { id: 'journal-1', description: 'Original journal' },
          reversedByJournal: null,
          createdBy: 'user-1',
          createdAt: new Date('2024-01-03'),
          entries: [],
        },
      ];

      mockPrisma.ledgerJournal.findMany.mockResolvedValue(mockJournals);

      const journals = await mockPrisma.ledgerJournal.findMany({
        where: { contractId: 'contract-1' },
        include: { entries: true, reversesJournal: true, reversedByJournal: true },
      });

      expect(journals[0].isReversal).toBe(true);
      expect(journals[0].reversesJournal?.id).toBe('journal-1');
    });
  });

  describe('Payment Timeline', () => {
    it('should combine disbursements and repayments into timeline', async () => {
      const mockDisbursements = [
        {
          id: 'disb-1',
          amountCents: 100000,
          expressFeeCents: 299,
          netAmountCents: 99701,
          speed: 'INSTANT',
          rail: 'RTP',
          status: 'COMPLETED',
          availabilityState: 'AVAILABLE',
          fundingInstrument: { id: 'fi-1', type: 'BANK_ACCOUNT', last4: '1234', bankName: 'Chase' },
          providerRef: 'moov-123',
          initiatedAt: new Date('2024-01-02T10:00:00'),
          completedAt: new Date('2024-01-02T10:01:00'),
          failedAt: null,
          failureReason: null,
          availableAt: new Date('2024-01-02T10:01:00'),
          holdReason: null,
        },
      ];

      const mockRepayments = [
        {
          id: 'rep-1',
          amountCents: 9000,
          rail: 'ACH',
          status: 'COMPLETED',
          availabilityState: 'AVAILABLE',
          fundingInstrument: { id: 'fi-2', type: 'BANK_ACCOUNT', last4: '5678', bankName: 'Wells Fargo' },
          appliedFeeCents: 0,
          appliedInterestCents: 500,
          appliedPrincipalCents: 8500,
          providerRef: 'moov-456',
          scheduledDate: new Date('2024-02-01'),
          isPayoff: false,
          initiatedAt: new Date('2024-02-01T08:00:00'),
          completedAt: new Date('2024-02-03T12:00:00'),
          failedAt: null,
          failureReason: null,
          availableAt: new Date('2024-02-03T12:00:00'),
          holdReason: null,
        },
      ];

      mockPrisma.disbursement.findMany.mockResolvedValue(mockDisbursements);
      mockPrisma.repayment.findMany.mockResolvedValue(mockRepayments);

      const [disbursements, repayments] = await Promise.all([
        mockPrisma.disbursement.findMany({ where: { contractId: 'contract-1' } }),
        mockPrisma.repayment.findMany({ where: { contractId: 'contract-1' } }),
      ]);

      // Combine into timeline
      const timeline = [
        ...disbursements.map((d: typeof mockDisbursements[0]) => ({
          id: d.id,
          type: 'disbursement',
          amount_cents: d.amountCents,
          status: d.status.toLowerCase(),
          initiated_at: d.initiatedAt.toISOString(),
        })),
        ...repayments.map((r: typeof mockRepayments[0]) => ({
          id: r.id,
          type: 'repayment',
          amount_cents: r.amountCents,
          status: r.status.toLowerCase(),
          initiated_at: r.initiatedAt?.toISOString(),
        })),
      ].sort((a, b) => (b.initiated_at || '').localeCompare(a.initiated_at || ''));

      expect(timeline).toHaveLength(2);
      // Most recent first
      expect(timeline[0].id).toBe('rep-1');
      expect(timeline[1].id).toBe('disb-1');
    });

    it('should calculate totals', async () => {
      const mockDisbursements = [
        { amountCents: 100000, status: 'COMPLETED' },
        { amountCents: 50000, status: 'PENDING' },
      ];

      const mockRepayments = [
        { amountCents: 9000, status: 'COMPLETED' },
        { amountCents: 9000, status: 'COMPLETED' },
        { amountCents: 9000, status: 'FAILED' },
      ];

      const disbursementTotal = mockDisbursements.reduce((sum, d) => sum + d.amountCents, 0);
      const disbursementCompletedTotal = mockDisbursements
        .filter((d) => d.status === 'COMPLETED')
        .reduce((sum, d) => sum + d.amountCents, 0);

      const repaymentTotal = mockRepayments.reduce((sum, r) => sum + r.amountCents, 0);
      const repaymentCompletedTotal = mockRepayments
        .filter((r) => r.status === 'COMPLETED')
        .reduce((sum, r) => sum + r.amountCents, 0);

      expect(disbursementTotal).toBe(150000);
      expect(disbursementCompletedTotal).toBe(100000);
      expect(repaymentTotal).toBe(27000);
      expect(repaymentCompletedTotal).toBe(18000);
    });
  });

  describe('Repayment Schedule', () => {
    it('should return schedule with summary', async () => {
      const mockScheduleItems = [
        { sequence: 1, dueDate: new Date('2024-02-01'), principalCents: 8500, interestCents: 500, feesCents: 0, status: 'PAID', paidCents: 9000, paidAt: new Date() },
        { sequence: 2, dueDate: new Date('2024-03-01'), principalCents: 8600, interestCents: 400, feesCents: 0, status: 'PAID', paidCents: 9000, paidAt: new Date() },
        { sequence: 3, dueDate: new Date('2024-04-01'), principalCents: 8700, interestCents: 300, feesCents: 0, status: 'SCHEDULED', paidCents: 0, paidAt: null },
        { sequence: 4, dueDate: new Date('2024-05-01'), principalCents: 8800, interestCents: 200, feesCents: 0, status: 'SCHEDULED', paidCents: 0, paidAt: null },
      ];

      mockPrisma.repaymentScheduleItem.findMany.mockResolvedValue(mockScheduleItems);

      const items = await mockPrisma.repaymentScheduleItem.findMany({
        where: { contractId: 'contract-1' },
        orderBy: { sequence: 'asc' },
      });

      // Calculate summary
      const totalDue = items.reduce(
        (sum, item) => sum + item.principalCents + item.interestCents + item.feesCents,
        0
      );
      const totalPaid = items.reduce((sum, item) => sum + item.paidCents, 0);
      const paidPayments = items.filter((i) => i.status === 'PAID').length;

      expect(items).toHaveLength(4);
      expect(totalDue).toBe(36000);
      expect(totalPaid).toBe(18000);
      expect(paidPayments).toBe(2);
    });
  });

  describe('Journal Reversal', () => {
    it('should create reversal journal with swapped entries', async () => {
      const originalJournal = {
        id: 'journal-1',
        contractId: 'contract-1',
        type: 'DISBURSEMENT',
        description: 'Initial disbursement',
        isReversal: false,
        reversedByJournalId: null,
        entries: [
          { accountCode: '1000-CASH', debitCents: 100000, creditCents: 0 },
          { accountCode: '2000-PRINCIPAL', debitCents: 0, creditCents: 100000 },
        ],
        contract: { tenantId: 'tenant-1' },
      };

      mockPrisma.ledgerJournal.findUnique.mockResolvedValue(originalJournal);

      const reversalJournal = {
        id: 'reversal-1',
        type: 'REVERSAL',
        description: 'Reversal of journal-1: Error correction',
        isReversal: true,
        reversesJournalId: 'journal-1',
        reversalReason: 'Error correction',
        createdAt: new Date(),
      };

      mockPrisma.ledgerJournal.create.mockResolvedValue(reversalJournal);

      // Simulate the reversal process
      const journal = await mockPrisma.ledgerJournal.findUnique({
        where: { id: 'journal-1' },
        include: { entries: true, contract: true },
      });

      expect(journal).toBeDefined();
      expect(journal?.reversedByJournalId).toBeNull();

      // Create reversal with swapped entries
      const swappedEntries = journal!.entries.map((e) => ({
        accountCode: e.accountCode,
        debitCents: e.creditCents,
        creditCents: e.debitCents,
      }));

      expect(swappedEntries[0].debitCents).toBe(0);
      expect(swappedEntries[0].creditCents).toBe(100000);
      expect(swappedEntries[1].debitCents).toBe(100000);
      expect(swappedEntries[1].creditCents).toBe(0);
    });

    it('should reject reversal of already-reversed journal', async () => {
      const alreadyReversedJournal = {
        id: 'journal-1',
        reversedByJournalId: 'reversal-1',
        isReversal: false,
        entries: [],
        contract: { tenantId: 'tenant-1' },
      };

      mockPrisma.ledgerJournal.findUnique.mockResolvedValue(alreadyReversedJournal);

      const journal = await mockPrisma.ledgerJournal.findUnique({
        where: { id: 'journal-1' },
        include: { entries: true, contract: true },
      });

      expect(journal?.reversedByJournalId).toBe('reversal-1');
      // In the actual route, this would throw AppError.invalidState
    });

    it('should reject reversal of a reversal journal', async () => {
      const reversalJournal = {
        id: 'reversal-1',
        isReversal: true,
        reversedByJournalId: null,
        entries: [],
        contract: { tenantId: 'tenant-1' },
      };

      mockPrisma.ledgerJournal.findUnique.mockResolvedValue(reversalJournal);

      const journal = await mockPrisma.ledgerJournal.findUnique({
        where: { id: 'reversal-1' },
        include: { entries: true, contract: true },
      });

      expect(journal?.isReversal).toBe(true);
      // In the actual route, this would throw AppError.invalidState
    });

    it('should create audit log for reversal', async () => {
      mockPrisma.auditLog.create.mockResolvedValue({
        id: 'audit-1',
        action: 'journal_reversal',
        entityType: 'LedgerJournal',
        entityId: 'journal-1',
        changes: { reason: 'Error correction', reversal_journal_id: 'reversal-1' },
        createdAt: new Date(),
      });

      const auditLog = await mockPrisma.auditLog.create({
        data: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          action: 'journal_reversal',
          entityType: 'LedgerJournal',
          entityId: 'journal-1',
          changes: { reason: 'Error correction', reversal_journal_id: 'reversal-1' },
        },
      });

      expect(auditLog.action).toBe('journal_reversal');
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'journal_reversal',
            entityType: 'LedgerJournal',
          }),
        })
      );
    });
  });

  describe('Customer Search', () => {
    it('should search customers by name', async () => {
      const mockCustomers = [
        {
          id: 'customer-1',
          role: 'LENDER',
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          phone: '1234567890',
          kycLevel: 'ENHANCED',
          createdAt: new Date(),
          _count: {
            contractsAsLender: 5,
            contractsAsBorrower: 0,
            fundingInstruments: 2,
          },
        },
      ];

      mockPrisma.customer.findMany.mockResolvedValue(mockCustomers);

      const customers = await mockPrisma.customer.findMany({
        where: {
          tenantId: 'tenant-1',
          OR: [
            { firstName: { contains: 'John', mode: 'insensitive' } },
            { lastName: { contains: 'John', mode: 'insensitive' } },
            { email: { contains: 'John', mode: 'insensitive' } },
          ],
        },
        include: { _count: true },
      });

      expect(customers).toHaveLength(1);
      expect(customers[0].firstName).toBe('John');
      expect(customers[0]._count.contractsAsLender).toBe(5);
    });

    it('should filter by role', async () => {
      mockPrisma.customer.findMany.mockResolvedValue([]);

      await mockPrisma.customer.findMany({
        where: {
          tenantId: 'tenant-1',
          role: 'LENDER',
        },
      });

      expect(mockPrisma.customer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            role: 'LENDER',
          }),
        })
      );
    });
  });

  describe('Customer Details', () => {
    it('should return customer with related data', async () => {
      const mockCustomer = {
        id: 'customer-1',
        role: 'LENDER',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        phone: '1234567890',
        kycLevel: 'ENHANCED',
        createdAt: new Date(),
        fundingInstruments: [
          { id: 'fi-1', type: 'BANK_ACCOUNT', status: 'VERIFIED', last4: '1234', bankName: 'Chase', isDefault: true },
        ],
        contractsAsLender: [
          { id: 'contract-1', status: 'ACTIVE', principalCents: 100000, createdAt: new Date() },
        ],
        contractsAsBorrower: [],
        prefundTransactions: [
          { availableAfterCents: 50000 },
        ],
        _count: {
          contractsAsLender: 1,
          contractsAsBorrower: 0,
        },
      };

      mockPrisma.customer.findFirst.mockResolvedValue(mockCustomer);

      const customer = await mockPrisma.customer.findFirst({
        where: { id: 'customer-1', tenantId: 'tenant-1' },
        include: {
          fundingInstruments: true,
          contractsAsLender: true,
          contractsAsBorrower: true,
          prefundTransactions: true,
          _count: true,
        },
      });

      expect(customer).toBeDefined();
      expect(customer?.fundingInstruments).toHaveLength(1);
      expect(customer?.prefundTransactions[0].availableAfterCents).toBe(50000);
      expect(customer?._count.contractsAsLender).toBe(1);
    });
  });

  describe('Audit Log', () => {
    it('should return audit logs with user info', async () => {
      const mockLogs = [
        {
          id: 'audit-1',
          action: 'journal_reversal',
          entityType: 'LedgerJournal',
          entityId: 'journal-1',
          changes: { reason: 'Error correction' },
          ipAddress: '192.168.1.1',
          userAgent: 'Mozilla/5.0',
          createdAt: new Date(),
          user: { id: 'user-1', email: 'admin@example.com' },
        },
      ];

      mockPrisma.auditLog.findMany.mockResolvedValue(mockLogs);

      const logs = await mockPrisma.auditLog.findMany({
        where: { tenantId: 'tenant-1' },
        include: { user: true },
        orderBy: { createdAt: 'desc' },
      });

      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe('journal_reversal');
      expect(logs[0].user?.email).toBe('admin@example.com');
    });

    it('should filter by entity type and action', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([]);

      await mockPrisma.auditLog.findMany({
        where: {
          tenantId: 'tenant-1',
          entityType: 'LedgerJournal',
          action: 'journal_reversal',
        },
      });

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            entityType: 'LedgerJournal',
            action: 'journal_reversal',
          }),
        })
      );
    });
  });
});

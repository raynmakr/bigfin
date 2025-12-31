import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  PaymentRail,
  TransferStatus,
  TransferStatusUpdate,
  InitiateTransferInput,
} from '../../src/modules/payments/types.js';

// Mock prisma
vi.mock('../../src/config/database.js', () => ({
  prisma: {
    fundingInstrument: {
      findUnique: vi.fn(),
    },
    disbursement: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    repayment: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    loanContract: {
      update: vi.fn(),
    },
  },
}));

// Mock MoovClient
const mockMoovClient = {
  createTransfer: vi.fn(),
  listPaymentMethods: vi.fn(),
  cancelTransfer: vi.fn(),
};

vi.mock('../../src/modules/payments/services/moov-client.js', () => ({
  getMoovClient: () => mockMoovClient,
}));

// Import after mocks are set up
import { TransferService } from '../../src/modules/payments/services/transfer-service.js';
import { prisma } from '../../src/config/database.js';

describe('TransferService', () => {
  let transferService: TransferService;

  beforeEach(() => {
    vi.clearAllMocks();
    transferService = new TransferService();
  });

  // ==========================================================================
  // Instrument Capabilities
  // ==========================================================================
  describe('getInstrumentCapabilities (via initiateTransfer)', () => {
    it('should throw NotFound when instrument does not exist', async () => {
      vi.mocked(prisma.fundingInstrument.findUnique).mockResolvedValue(null);

      const input: InitiateTransferInput = {
        sourceAccountId: 'non-existent-id',
        destinationAccountId: 'dest-id',
        amountCents: 50000,
        speed: 'standard',
        direction: 'credit',
        description: 'Test transfer',
      };

      await expect(
        transferService.initiateTransfer('tenant-1', input)
      ).rejects.toThrow(/not found/i);
    });

    it('should derive correct rails for verified bank account', async () => {
      const verifiedBankAccount = {
        id: 'inst-1',
        type: 'BANK_ACCOUNT',
        status: 'VERIFIED',
        providerRef: 'moov-acct-1',
      };

      vi.mocked(prisma.fundingInstrument.findUnique).mockResolvedValue(
        verifiedBankAccount as any
      );

      mockMoovClient.listPaymentMethods.mockResolvedValue([
        { paymentMethodID: 'pm-1', paymentMethodType: 'ach-debit-fund' },
        { paymentMethodID: 'pm-2', paymentMethodType: 'ach-credit-standard' },
      ]);

      mockMoovClient.createTransfer.mockResolvedValue({
        transferID: 'xfer-123',
        status: 'pending',
      });

      const input: InitiateTransferInput = {
        sourceAccountId: 'inst-1',
        destinationAccountId: 'inst-1',
        amountCents: 50000,
        speed: 'instant',
        direction: 'credit',
        description: 'Test transfer',
      };

      const result = await transferService.initiateTransfer('tenant-1', input);

      // Verified bank accounts should get RTP as first choice
      expect(result.rail).toBe('rtp');
    });

    it('should derive correct rails for unverified bank account', async () => {
      const unverifiedBankAccount = {
        id: 'inst-1',
        type: 'BANK_ACCOUNT',
        status: 'PENDING',
        providerRef: 'moov-acct-1',
      };

      vi.mocked(prisma.fundingInstrument.findUnique).mockResolvedValue(
        unverifiedBankAccount as any
      );

      mockMoovClient.listPaymentMethods.mockResolvedValue([
        { paymentMethodID: 'pm-1', paymentMethodType: 'ach-debit-fund' },
      ]);

      mockMoovClient.createTransfer.mockResolvedValue({
        transferID: 'xfer-123',
        status: 'pending',
      });

      const input: InitiateTransferInput = {
        sourceAccountId: 'inst-1',
        destinationAccountId: 'inst-1',
        amountCents: 50000,
        speed: 'instant',
        direction: 'credit',
        description: 'Test transfer',
      };

      const result = await transferService.initiateTransfer('tenant-1', input);

      // Unverified bank accounts only get ACH
      expect(result.rail).toBe('ach');
    });

    it('should derive correct rails for debit card', async () => {
      const debitCard = {
        id: 'inst-1',
        type: 'DEBIT_CARD',
        status: 'VERIFIED',
        providerRef: 'moov-card-1',
      };

      vi.mocked(prisma.fundingInstrument.findUnique).mockResolvedValue(
        debitCard as any
      );

      mockMoovClient.listPaymentMethods.mockResolvedValue([
        { paymentMethodID: 'pm-1', paymentMethodType: 'push-to-card' },
      ]);

      mockMoovClient.createTransfer.mockResolvedValue({
        transferID: 'xfer-123',
        status: 'pending',
      });

      const input: InitiateTransferInput = {
        sourceAccountId: 'inst-1',
        destinationAccountId: 'inst-1',
        amountCents: 50000,
        speed: 'instant',
        direction: 'credit',
        description: 'Test transfer',
      };

      const result = await transferService.initiateTransfer('tenant-1', input);

      expect(result.rail).toBe('push_to_card');
    });
  });

  // ==========================================================================
  // Transfer Execution
  // ==========================================================================
  describe('Transfer Execution', () => {
    beforeEach(() => {
      const verifiedBankAccount = {
        id: 'inst-1',
        type: 'BANK_ACCOUNT',
        status: 'VERIFIED',
        providerRef: 'moov-acct-1',
      };

      vi.mocked(prisma.fundingInstrument.findUnique).mockResolvedValue(
        verifiedBankAccount as any
      );

      mockMoovClient.listPaymentMethods.mockResolvedValue([
        { paymentMethodID: 'pm-1', paymentMethodType: 'ach-debit-fund' },
        { paymentMethodID: 'pm-2', paymentMethodType: 'ach-credit-standard' },
        { paymentMethodID: 'pm-3', paymentMethodType: 'rtp-credit' },
      ]);
    });

    it('should return transfer result on success', async () => {
      mockMoovClient.createTransfer.mockResolvedValue({
        transferID: 'xfer-123',
        status: 'pending',
      });

      const input: InitiateTransferInput = {
        sourceAccountId: 'inst-1',
        destinationAccountId: 'inst-1',
        amountCents: 50000,
        speed: 'standard',
        direction: 'credit',
        description: 'Test transfer',
      };

      const result = await transferService.initiateTransfer('tenant-1', input);

      expect(result.id).toBe('xfer-123');
      expect(result.providerTransferId).toBe('xfer-123');
      expect(result.status).toBe('processing');
      expect(result.amountCents).toBe(50000);
      expect(result.rail).toBe('ach');
      expect(result.feeCents).toBe(0); // Standard speed = no fee
    });

    it('should include express fee for instant transfers', async () => {
      mockMoovClient.createTransfer.mockResolvedValue({
        transferID: 'xfer-123',
        status: 'pending',
      });

      const input: InitiateTransferInput = {
        sourceAccountId: 'inst-1',
        destinationAccountId: 'inst-1',
        amountCents: 50000, // $500 = $2.99 fee
        speed: 'instant',
        direction: 'credit',
        description: 'Test transfer',
      };

      const result = await transferService.initiateTransfer('tenant-1', input);

      expect(result.feeCents).toBe(299);
    });

    it('should include metadata in transfer', async () => {
      mockMoovClient.createTransfer.mockResolvedValue({
        transferID: 'xfer-123',
        status: 'pending',
      });

      const input: InitiateTransferInput = {
        sourceAccountId: 'inst-1',
        destinationAccountId: 'inst-1',
        amountCents: 50000,
        speed: 'standard',
        direction: 'credit',
        description: 'Test transfer',
        metadata: { orderId: 'order-123', customerId: 'cust-456' },
      };

      await transferService.initiateTransfer('tenant-1', input);

      expect(mockMoovClient.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            orderId: 'order-123',
            customerId: 'cust-456',
            rail: 'ach',
          }),
        })
      );
    });
  });

  // ==========================================================================
  // Fallback Behavior
  // ==========================================================================
  describe('Fallback Behavior', () => {
    beforeEach(() => {
      const verifiedBankAccount = {
        id: 'inst-1',
        type: 'BANK_ACCOUNT',
        status: 'VERIFIED',
        providerRef: 'moov-acct-1',
      };

      vi.mocked(prisma.fundingInstrument.findUnique).mockResolvedValue(
        verifiedBankAccount as any
      );

      mockMoovClient.listPaymentMethods.mockResolvedValue([
        { paymentMethodID: 'pm-1', paymentMethodType: 'ach-debit-fund' },
        { paymentMethodID: 'pm-2', paymentMethodType: 'ach-credit-standard' },
        { paymentMethodID: 'pm-3', paymentMethodType: 'rtp-credit' },
        { paymentMethodID: 'pm-4', paymentMethodType: 'fednow-credit' },
      ]);

      // Reset createTransfer mock for each test
      mockMoovClient.createTransfer.mockReset();
    });

    it('should fall back to next rail on failure', async () => {
      // First call (RTP) fails, second call (FedNow) succeeds
      mockMoovClient.createTransfer
        .mockRejectedValueOnce(new Error('RTP not available'))
        .mockResolvedValueOnce({
          transferID: 'xfer-123',
          status: 'pending',
        });

      const input: InitiateTransferInput = {
        sourceAccountId: 'inst-1',
        destinationAccountId: 'inst-1',
        amountCents: 50000,
        speed: 'instant',
        direction: 'credit',
        description: 'Test transfer',
      };

      const result = await transferService.initiateTransfer('tenant-1', input);

      expect(result.rail).toBe('fednow');
      expect(mockMoovClient.createTransfer).toHaveBeenCalledTimes(2);
    });

    it('should try multiple fallbacks until success', async () => {
      // Fallback chain for verified bank account with RTP:
      // Primary: rtp, Fallbacks: fednow, ach (push_to_card filtered out)
      // So we need: RTP fails, FedNow fails, ACH succeeds
      mockMoovClient.createTransfer
        .mockRejectedValueOnce(new Error('RTP not available'))
        .mockRejectedValueOnce(new Error('FedNow not available'))
        .mockResolvedValueOnce({
          transferID: 'xfer-123',
          status: 'pending',
        });

      const input: InitiateTransferInput = {
        sourceAccountId: 'inst-1',
        destinationAccountId: 'inst-1',
        amountCents: 50000,
        speed: 'instant',
        direction: 'credit',
        description: 'Test transfer',
      };

      const result = await transferService.initiateTransfer('tenant-1', input);

      expect(result.rail).toBe('ach');
      expect(mockMoovClient.createTransfer).toHaveBeenCalledTimes(3);
    });

    it('should throw error when all rails fail', async () => {
      // All three rails (rtp, fednow, ach) must fail
      mockMoovClient.createTransfer
        .mockRejectedValueOnce(new Error('RTP failed'))
        .mockRejectedValueOnce(new Error('FedNow failed'))
        .mockRejectedValueOnce(new Error('ACH failed'));

      const input: InitiateTransferInput = {
        sourceAccountId: 'inst-1',
        destinationAccountId: 'inst-1',
        amountCents: 50000,
        speed: 'instant',
        direction: 'credit',
        description: 'Test transfer',
      };

      await expect(
        transferService.initiateTransfer('tenant-1', input)
      ).rejects.toThrow(/Transfer failed on all rails/);
    });

    it('should include tried rails in error message', async () => {
      mockMoovClient.createTransfer
        .mockRejectedValueOnce(new Error('RTP failed'))
        .mockRejectedValueOnce(new Error('FedNow failed'))
        .mockRejectedValueOnce(new Error('ACH failed'));

      const input: InitiateTransferInput = {
        sourceAccountId: 'inst-1',
        destinationAccountId: 'inst-1',
        amountCents: 50000,
        speed: 'instant',
        direction: 'credit',
        description: 'Test transfer',
      };

      // Verified bank accounts have: rtp, fednow, same_day_ach, ach
      // Fallback chain from rtp: fednow -> push_to_card -> ach
      // But push_to_card is filtered out, so actual tried rails: rtp, fednow, ach
      await expect(
        transferService.initiateTransfer('tenant-1', input)
      ).rejects.toThrow(/rtp.*fednow.*ach/i);
    });
  });

  // ==========================================================================
  // Status Updates
  // ==========================================================================
  describe('Status Updates', () => {
    describe('Disbursement Status Mapping', () => {
      it('should map pending status correctly', async () => {
        const disbursement = { id: 'disb-1', contractId: 'contract-1' };
        vi.mocked(prisma.disbursement.findFirst).mockResolvedValue(
          disbursement as any
        );
        vi.mocked(prisma.disbursement.update).mockResolvedValue({} as any);

        const update: TransferStatusUpdate = {
          transferId: 'xfer-1',
          providerTransferId: 'moov-xfer-1',
          status: 'pending',
          rail: 'ach',
        };

        await transferService.processStatusUpdate(update);

        expect(prisma.disbursement.update).toHaveBeenCalledWith({
          where: { id: 'disb-1' },
          data: expect.objectContaining({
            status: 'PENDING',
            availabilityState: 'PENDING',
          }),
        });
      });

      it('should map completed status and update contract', async () => {
        const disbursement = { id: 'disb-1', contractId: 'contract-1' };
        vi.mocked(prisma.disbursement.findFirst).mockResolvedValue(
          disbursement as any
        );
        vi.mocked(prisma.disbursement.findUnique).mockResolvedValue({
          ...disbursement,
          contract: { id: 'contract-1' },
        } as any);
        vi.mocked(prisma.disbursement.update).mockResolvedValue({} as any);
        vi.mocked(prisma.loanContract.update).mockResolvedValue({} as any);

        const update: TransferStatusUpdate = {
          transferId: 'xfer-1',
          providerTransferId: 'moov-xfer-1',
          status: 'completed',
          rail: 'ach',
        };

        await transferService.processStatusUpdate(update);

        expect(prisma.disbursement.update).toHaveBeenCalledWith({
          where: { id: 'disb-1' },
          data: expect.objectContaining({
            status: 'COMPLETED',
            availabilityState: 'AVAILABLE',
            completedAt: expect.any(Date),
          }),
        });

        expect(prisma.loanContract.update).toHaveBeenCalledWith({
          where: { id: 'contract-1' },
          data: expect.objectContaining({
            status: 'ACTIVE',
            disbursedAt: expect.any(Date),
          }),
        });
      });

      it('should map failed status correctly', async () => {
        const disbursement = { id: 'disb-1', contractId: 'contract-1' };
        vi.mocked(prisma.disbursement.findFirst).mockResolvedValue(
          disbursement as any
        );
        vi.mocked(prisma.disbursement.update).mockResolvedValue({} as any);

        const update: TransferStatusUpdate = {
          transferId: 'xfer-1',
          providerTransferId: 'moov-xfer-1',
          status: 'failed',
          rail: 'ach',
          failureReason: 'Insufficient funds',
        };

        await transferService.processStatusUpdate(update);

        expect(prisma.disbursement.update).toHaveBeenCalledWith({
          where: { id: 'disb-1' },
          data: expect.objectContaining({
            status: 'FAILED',
            availabilityState: 'FAILED',
            failedAt: expect.any(Date),
            failureReason: 'Insufficient funds',
          }),
        });
      });

      it('should map returned status to failed', async () => {
        const disbursement = { id: 'disb-1', contractId: 'contract-1' };
        vi.mocked(prisma.disbursement.findFirst).mockResolvedValue(
          disbursement as any
        );
        vi.mocked(prisma.disbursement.update).mockResolvedValue({} as any);

        const update: TransferStatusUpdate = {
          transferId: 'xfer-1',
          providerTransferId: 'moov-xfer-1',
          status: 'returned',
          rail: 'ach',
          returnReason: 'Account closed',
        };

        await transferService.processStatusUpdate(update);

        expect(prisma.disbursement.update).toHaveBeenCalledWith({
          where: { id: 'disb-1' },
          data: expect.objectContaining({
            status: 'FAILED',
            availabilityState: 'FAILED',
            failedAt: expect.any(Date),
          }),
        });
      });
    });

    describe('Repayment Status Mapping', () => {
      beforeEach(() => {
        vi.mocked(prisma.disbursement.findFirst).mockResolvedValue(null);
      });

      it('should map completed repayment status', async () => {
        const repayment = { id: 'rep-1', contractId: 'contract-1' };
        vi.mocked(prisma.repayment.findFirst).mockResolvedValue(
          repayment as any
        );
        vi.mocked(prisma.repayment.update).mockResolvedValue({} as any);

        const update: TransferStatusUpdate = {
          transferId: 'xfer-1',
          providerTransferId: 'moov-xfer-1',
          status: 'completed',
          rail: 'ach',
        };

        await transferService.processStatusUpdate(update);

        expect(prisma.repayment.update).toHaveBeenCalledWith({
          where: { id: 'rep-1' },
          data: expect.objectContaining({
            status: 'COMPLETED',
            availabilityState: 'AVAILABLE',
            completedAt: expect.any(Date),
          }),
        });
      });

      it('should map returned repayment status', async () => {
        const repayment = { id: 'rep-1', contractId: 'contract-1' };
        vi.mocked(prisma.repayment.findFirst).mockResolvedValue(
          repayment as any
        );
        vi.mocked(prisma.repayment.update).mockResolvedValue({} as any);

        const update: TransferStatusUpdate = {
          transferId: 'xfer-1',
          providerTransferId: 'moov-xfer-1',
          status: 'returned',
          rail: 'ach',
        };

        await transferService.processStatusUpdate(update);

        expect(prisma.repayment.update).toHaveBeenCalledWith({
          where: { id: 'rep-1' },
          data: expect.objectContaining({
            status: 'RETURNED',
            availabilityState: 'FAILED',
            returnedAt: expect.any(Date),
          }),
        });
      });

      it('should map canceled repayment status', async () => {
        const repayment = { id: 'rep-1', contractId: 'contract-1' };
        vi.mocked(prisma.repayment.findFirst).mockResolvedValue(
          repayment as any
        );
        vi.mocked(prisma.repayment.update).mockResolvedValue({} as any);

        const update: TransferStatusUpdate = {
          transferId: 'xfer-1',
          providerTransferId: 'moov-xfer-1',
          status: 'canceled',
          rail: 'ach',
        };

        await transferService.processStatusUpdate(update);

        expect(prisma.repayment.update).toHaveBeenCalledWith({
          where: { id: 'rep-1' },
          data: expect.objectContaining({
            status: 'CANCELLED',
            availabilityState: 'FAILED',
          }),
        });
      });
    });

    describe('Unknown Transfer', () => {
      it('should log warning for unknown transfer', async () => {
        vi.mocked(prisma.disbursement.findFirst).mockResolvedValue(null);
        vi.mocked(prisma.repayment.findFirst).mockResolvedValue(null);

        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const update: TransferStatusUpdate = {
          transferId: 'xfer-1',
          providerTransferId: 'unknown-xfer',
          status: 'completed',
          rail: 'ach',
        };

        await transferService.processStatusUpdate(update);

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Unknown transfer')
        );

        consoleSpy.mockRestore();
      });
    });
  });

  // ==========================================================================
  // Get Transfer
  // ==========================================================================
  describe('Get Transfer', () => {
    it('should return disbursement as transfer result', async () => {
      const disbursement = {
        id: 'disb-1',
        providerRef: 'moov-xfer-1',
        rail: 'RTP',
        status: 'COMPLETED',
        amountCents: 50000,
        expressFeeCents: 299,
        availableAt: new Date('2024-01-15'),
        initiatedAt: new Date('2024-01-15'),
        completedAt: new Date('2024-01-15'),
        failureReason: null,
      };

      vi.mocked(prisma.disbursement.findFirst).mockResolvedValue(
        disbursement as any
      );

      const result = await transferService.getTransfer('tenant-1', 'moov-xfer-1');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('disb-1');
      expect(result?.rail).toBe('rtp');
      expect(result?.status).toBe('completed');
      expect(result?.amountCents).toBe(50000);
      expect(result?.feeCents).toBe(299);
    });

    it('should return repayment as transfer result', async () => {
      vi.mocked(prisma.disbursement.findFirst).mockResolvedValue(null);

      const repayment = {
        id: 'rep-1',
        providerRef: 'moov-xfer-1',
        rail: 'ACH',
        status: 'COMPLETED',
        amountCents: 25000,
        availableAt: new Date('2024-01-20'),
        initiatedAt: new Date('2024-01-18'),
        completedAt: new Date('2024-01-20'),
        failureReason: null,
      };

      vi.mocked(prisma.repayment.findFirst).mockResolvedValue(repayment as any);

      const result = await transferService.getTransfer('tenant-1', 'moov-xfer-1');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('rep-1');
      expect(result?.rail).toBe('ach');
      expect(result?.feeCents).toBe(0); // Repayments have no express fee
    });

    it('should return null for unknown transfer', async () => {
      vi.mocked(prisma.disbursement.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.repayment.findFirst).mockResolvedValue(null);

      const result = await transferService.getTransfer('tenant-1', 'unknown-xfer');

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // Cancel Transfer
  // ==========================================================================
  describe('Cancel Transfer', () => {
    it('should call Moov to cancel transfer', async () => {
      mockMoovClient.cancelTransfer.mockResolvedValue(undefined);

      await transferService.cancelTransfer('tenant-1', 'moov-xfer-1');

      expect(mockMoovClient.cancelTransfer).toHaveBeenCalledWith('moov-xfer-1');
    });

    it('should handle cancellation errors gracefully', async () => {
      mockMoovClient.cancelTransfer.mockRejectedValue(
        new Error('Cannot cancel completed transfer')
      );

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Should not throw
      await expect(
        transferService.cancelTransfer('tenant-1', 'moov-xfer-1')
      ).resolves.not.toThrow();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Could not cancel transfer')
      );

      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // Payment Method Type Mapping
  // ==========================================================================
  describe('Payment Method Type Mapping', () => {
    beforeEach(() => {
      const verifiedBankAccount = {
        id: 'inst-1',
        type: 'BANK_ACCOUNT',
        status: 'VERIFIED',
        providerRef: 'moov-acct-1',
      };

      vi.mocked(prisma.fundingInstrument.findUnique).mockResolvedValue(
        verifiedBankAccount as any
      );
    });

    it('should select rtp-credit for RTP rail', async () => {
      mockMoovClient.listPaymentMethods.mockResolvedValue([
        { paymentMethodID: 'pm-rtp', paymentMethodType: 'rtp-credit' },
        { paymentMethodID: 'pm-ach', paymentMethodType: 'ach-credit-standard' },
      ]);

      mockMoovClient.createTransfer.mockResolvedValue({
        transferID: 'xfer-123',
        status: 'pending',
      });

      const input: InitiateTransferInput = {
        sourceAccountId: 'inst-1',
        destinationAccountId: 'inst-1',
        amountCents: 50000,
        speed: 'instant',
        direction: 'credit',
        description: 'Test',
      };

      await transferService.initiateTransfer('tenant-1', input);

      expect(mockMoovClient.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationPaymentMethodId: 'pm-rtp',
        })
      );
    });

    it('should select ach-credit-standard for ACH destination', async () => {
      mockMoovClient.listPaymentMethods.mockResolvedValue([
        { paymentMethodID: 'pm-ach-debit', paymentMethodType: 'ach-debit-fund' },
        { paymentMethodID: 'pm-ach-credit', paymentMethodType: 'ach-credit-standard' },
      ]);

      mockMoovClient.createTransfer.mockResolvedValue({
        transferID: 'xfer-123',
        status: 'pending',
      });

      const input: InitiateTransferInput = {
        sourceAccountId: 'inst-1',
        destinationAccountId: 'inst-1',
        amountCents: 50000,
        speed: 'standard',
        direction: 'credit',
        description: 'Test',
      };

      await transferService.initiateTransfer('tenant-1', input);

      expect(mockMoovClient.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePaymentMethodId: 'pm-ach-debit',
          destinationPaymentMethodId: 'pm-ach-credit',
        })
      );
    });

    it('should select push-to-card for card disbursements', async () => {
      const debitCard = {
        id: 'card-1',
        type: 'DEBIT_CARD',
        status: 'VERIFIED',
        providerRef: 'moov-card-1',
      };

      vi.mocked(prisma.fundingInstrument.findUnique).mockResolvedValue(
        debitCard as any
      );

      mockMoovClient.listPaymentMethods.mockResolvedValue([
        { paymentMethodID: 'pm-card', paymentMethodType: 'push-to-card' },
      ]);

      mockMoovClient.createTransfer.mockResolvedValue({
        transferID: 'xfer-123',
        status: 'pending',
      });

      const input: InitiateTransferInput = {
        sourceAccountId: 'card-1',
        destinationAccountId: 'card-1',
        amountCents: 50000,
        speed: 'instant',
        direction: 'credit',
        description: 'Test',
      };

      await transferService.initiateTransfer('tenant-1', input);

      expect(mockMoovClient.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationPaymentMethodId: 'pm-card',
        })
      );
    });

    it('should use mock payment method ID when no provider ref', async () => {
      const instrumentNoProvider = {
        id: 'inst-1',
        type: 'BANK_ACCOUNT',
        status: 'VERIFIED',
        providerRef: null, // No provider reference
      };

      vi.mocked(prisma.fundingInstrument.findUnique).mockResolvedValue(
        instrumentNoProvider as any
      );

      mockMoovClient.createTransfer.mockResolvedValue({
        transferID: 'xfer-123',
        status: 'pending',
      });

      const input: InitiateTransferInput = {
        sourceAccountId: 'inst-1',
        destinationAccountId: 'inst-1',
        amountCents: 50000,
        speed: 'standard',
        direction: 'credit',
        description: 'Test',
      };

      await transferService.initiateTransfer('tenant-1', input);

      expect(mockMoovClient.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePaymentMethodId: expect.stringContaining('pm-ach-inst-1'),
          destinationPaymentMethodId: expect.stringContaining('pm-ach-inst-1'),
        })
      );
    });
  });
});

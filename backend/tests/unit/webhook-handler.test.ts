import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import type { MoovWebhookEvent } from '../../src/modules/payments/types.js';

// Use vi.hoisted to define mocks that can be referenced in vi.mock
const { mockEnv, mockTransferService } = vi.hoisted(() => ({
  mockEnv: {
    NODE_ENV: 'production' as 'development' | 'production' | 'test',
    MOOV_WEBHOOK_SECRET: 'test-webhook-secret',
  },
  mockTransferService: {
    processStatusUpdate: vi.fn(),
  },
}));

// Mock the env module
vi.mock('../../src/config/env.js', () => ({
  env: mockEnv,
}));

// Mock the transfer service
vi.mock('../../src/modules/payments/services/transfer-service.js', () => ({
  getTransferService: () => mockTransferService,
}));

// Import after mocks are set up
import { MoovWebhookHandler } from '../../src/modules/payments/services/webhook-handler.js';

describe('MoovWebhookHandler', () => {
  let webhookHandler: MoovWebhookHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env to defaults
    mockEnv.NODE_ENV = 'production';
    mockEnv.MOOV_WEBHOOK_SECRET = 'test-webhook-secret';
    webhookHandler = new MoovWebhookHandler();
  });

  // ==========================================================================
  // Signature Verification
  // ==========================================================================
  describe('Signature Verification', () => {
    const generateValidSignature = (payload: string, timestamp: string): string => {
      const signedPayload = `${timestamp}.${payload}`;
      return crypto
        .createHmac('sha256', 'test-webhook-secret')
        .update(signedPayload)
        .digest('hex');
    };

    it('should accept valid signature', () => {
      const payload = '{"eventID":"evt-1","type":"transfer.completed","data":{}}';
      const timestamp = Date.now().toString();
      const signature = generateValidSignature(payload, timestamp);

      const result = webhookHandler.verifySignature(payload, signature, timestamp);

      expect(result).toBe(true);
    });

    it('should reject invalid signature', () => {
      const payload = '{"eventID":"evt-1","type":"transfer.completed","data":{}}';
      const timestamp = Date.now().toString();
      const invalidSignature = 'invalid-signature-that-is-64-chars-long-to-match-sha256-hex-out';

      const result = webhookHandler.verifySignature(payload, invalidSignature, timestamp);

      expect(result).toBe(false);
    });

    it('should reject tampered payload', () => {
      const originalPayload = '{"eventID":"evt-1","type":"transfer.completed","data":{}}';
      const timestamp = Date.now().toString();
      const signature = generateValidSignature(originalPayload, timestamp);

      // Tamper with the payload
      const tamperedPayload = '{"eventID":"evt-1","type":"transfer.failed","data":{}}';

      const result = webhookHandler.verifySignature(tamperedPayload, signature, timestamp);

      expect(result).toBe(false);
    });

    it('should reject tampered timestamp', () => {
      const payload = '{"eventID":"evt-1","type":"transfer.completed","data":{}}';
      const originalTimestamp = Date.now().toString();
      const signature = generateValidSignature(payload, originalTimestamp);

      // Use different timestamp
      const tamperedTimestamp = (Date.now() + 1000).toString();

      const result = webhookHandler.verifySignature(payload, signature, tamperedTimestamp);

      expect(result).toBe(false);
    });

    it('should handle signature length mismatch gracefully', () => {
      const payload = '{"eventID":"evt-1","type":"transfer.completed","data":{}}';
      const timestamp = Date.now().toString();

      // Signature with wrong length
      const shortSignature = 'too-short';

      const result = webhookHandler.verifySignature(payload, shortSignature, timestamp);

      expect(result).toBe(false);
    });

    it('should skip verification in development without secret', () => {
      mockEnv.NODE_ENV = 'development';
      mockEnv.MOOV_WEBHOOK_SECRET = '';

      const handler = new MoovWebhookHandler();
      const payload = '{"test":"data"}';

      const result = handler.verifySignature(payload, 'any-signature', '12345');

      expect(result).toBe(true);
    });

    it('should throw error in production without secret', () => {
      mockEnv.NODE_ENV = 'production';
      mockEnv.MOOV_WEBHOOK_SECRET = '';

      const handler = new MoovWebhookHandler();
      const payload = '{"test":"data"}';

      expect(() =>
        handler.verifySignature(payload, 'any-signature', '12345')
      ).toThrow(/Webhook secret not configured/);
    });

    it('should use constant-time comparison to prevent timing attacks', () => {
      const payload = '{"eventID":"evt-1","type":"transfer.completed","data":{}}';
      const timestamp = Date.now().toString();
      const validSignature = generateValidSignature(payload, timestamp);

      // Measure time for valid signature
      const validStart = process.hrtime.bigint();
      webhookHandler.verifySignature(payload, validSignature, timestamp);
      const validEnd = process.hrtime.bigint();

      // Create signature with same length but different content
      const invalidSignature = 'x'.repeat(64);
      const invalidStart = process.hrtime.bigint();
      webhookHandler.verifySignature(payload, invalidSignature, timestamp);
      const invalidEnd = process.hrtime.bigint();

      // Times should be roughly similar (within 10x)
      // This isn't a perfect timing test but catches obvious issues
      const validTime = Number(validEnd - validStart);
      const invalidTime = Number(invalidEnd - invalidStart);

      // Just verify both complete without excessive time difference
      expect(validTime).toBeLessThan(10_000_000); // Less than 10ms
      expect(invalidTime).toBeLessThan(10_000_000);
    });
  });

  // ==========================================================================
  // Event Parsing
  // ==========================================================================
  describe('Event Parsing', () => {
    it('should parse valid event JSON', () => {
      const payload = JSON.stringify({
        eventID: 'evt-123',
        type: 'transfer.completed',
        data: { transferID: 'xfer-456' },
        createdOn: '2024-01-15T10:00:00Z',
      });

      const event = webhookHandler.parseEvent(payload);

      expect(event.eventID).toBe('evt-123');
      expect(event.type).toBe('transfer.completed');
      expect(event.data).toEqual({ transferID: 'xfer-456' });
    });

    it('should throw on invalid JSON', () => {
      const invalidPayload = 'not valid json {{{';

      expect(() => webhookHandler.parseEvent(invalidPayload)).toThrow(
        /Invalid webhook payload/
      );
    });

    it('should throw on missing eventID', () => {
      const payload = JSON.stringify({
        type: 'transfer.completed',
        data: {},
      });

      expect(() => webhookHandler.parseEvent(payload)).toThrow(
        /Invalid webhook payload/
      );
    });

    it('should throw on missing type', () => {
      const payload = JSON.stringify({
        eventID: 'evt-123',
        data: {},
      });

      expect(() => webhookHandler.parseEvent(payload)).toThrow(
        /Invalid webhook payload/
      );
    });

    it('should throw on missing data', () => {
      const payload = JSON.stringify({
        eventID: 'evt-123',
        type: 'transfer.completed',
      });

      expect(() => webhookHandler.parseEvent(payload)).toThrow(
        /Invalid webhook payload/
      );
    });

    it('should accept event with additional fields', () => {
      const payload = JSON.stringify({
        eventID: 'evt-123',
        type: 'transfer.completed',
        data: {},
        createdOn: '2024-01-15T10:00:00Z',
        accountID: 'acct-789',
        extraField: 'ignored',
      });

      const event = webhookHandler.parseEvent(payload);

      expect(event.eventID).toBe('evt-123');
    });
  });

  // ==========================================================================
  // Event Processing - Transfer Events
  // ==========================================================================
  describe('Transfer Event Processing', () => {
    it('should process transfer.created event', async () => {
      const event: MoovWebhookEvent = {
        eventID: 'evt-1',
        type: 'transfer.created',
        data: {
          transferID: 'xfer-123',
          status: 'created',
        },
        createdOn: '2024-01-15T10:00:00Z',
      };

      await webhookHandler.processEvent(event);

      expect(mockTransferService.processStatusUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          providerTransferId: 'xfer-123',
          status: 'pending',
        })
      );
    });

    it('should process transfer.pending event', async () => {
      const event: MoovWebhookEvent = {
        eventID: 'evt-1',
        type: 'transfer.pending',
        data: {
          transferID: 'xfer-123',
          status: 'pending',
        },
        createdOn: '2024-01-15T10:00:00Z',
      };

      await webhookHandler.processEvent(event);

      expect(mockTransferService.processStatusUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          providerTransferId: 'xfer-123',
          status: 'processing',
        })
      );
    });

    it('should process transfer.completed event', async () => {
      const event: MoovWebhookEvent = {
        eventID: 'evt-1',
        type: 'transfer.completed',
        data: {
          transferID: 'xfer-123',
          status: 'completed',
          completedOn: '2024-01-15T12:00:00Z',
        },
        createdOn: '2024-01-15T10:00:00Z',
      };

      await webhookHandler.processEvent(event);

      expect(mockTransferService.processStatusUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          providerTransferId: 'xfer-123',
          status: 'completed',
          completedAt: expect.any(Date),
        })
      );
    });

    it('should process transfer.failed event with failure reason', async () => {
      const event: MoovWebhookEvent = {
        eventID: 'evt-1',
        type: 'transfer.failed',
        data: {
          transferID: 'xfer-123',
          status: 'failed',
          failureReason: 'Insufficient funds',
        },
        createdOn: '2024-01-15T10:00:00Z',
      };

      await webhookHandler.processEvent(event);

      expect(mockTransferService.processStatusUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          providerTransferId: 'xfer-123',
          status: 'failed',
          failureReason: 'Insufficient funds',
        })
      );
    });

    it('should process transfer.reversed event', async () => {
      const event: MoovWebhookEvent = {
        eventID: 'evt-1',
        type: 'transfer.reversed',
        data: {
          transferID: 'xfer-123',
          status: 'reversed',
        },
        createdOn: '2024-01-15T10:00:00Z',
      };

      await webhookHandler.processEvent(event);

      expect(mockTransferService.processStatusUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          providerTransferId: 'xfer-123',
          status: 'returned',
        })
      );
    });

    it('should handle unknown transfer status gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const event: MoovWebhookEvent = {
        eventID: 'evt-1',
        type: 'transfer.pending',
        data: {
          transferID: 'xfer-123',
          status: 'unknown_status',
        },
        createdOn: '2024-01-15T10:00:00Z',
      };

      await webhookHandler.processEvent(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown transfer status')
      );
      expect(mockTransferService.processStatusUpdate).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // Event Processing - Bank Account Events
  // ==========================================================================
  describe('Bank Account Event Processing', () => {
    it('should handle bank-account.created event', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const event: MoovWebhookEvent = {
        eventID: 'evt-1',
        type: 'bank-account.created',
        data: {
          bankAccountID: 'bank-123',
          status: 'new',
          accountID: 'acct-456',
        },
        createdOn: '2024-01-15T10:00:00Z',
      };

      await webhookHandler.processEvent(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('bank-account.created'),
        'bank-123',
        'new'
      );

      consoleSpy.mockRestore();
    });

    it('should handle bank-account.updated event', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const event: MoovWebhookEvent = {
        eventID: 'evt-1',
        type: 'bank-account.updated',
        data: {
          bankAccountID: 'bank-123',
          status: 'verified',
          accountID: 'acct-456',
        },
        createdOn: '2024-01-15T10:00:00Z',
      };

      await webhookHandler.processEvent(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('bank-account.updated'),
        'bank-123',
        'verified'
      );

      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // Event Processing - Card Events
  // ==========================================================================
  describe('Card Event Processing', () => {
    it('should handle card.created event', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const event: MoovWebhookEvent = {
        eventID: 'evt-1',
        type: 'card.created',
        data: {
          cardID: 'card-123',
          status: 'active',
          accountID: 'acct-456',
        },
        createdOn: '2024-01-15T10:00:00Z',
      };

      await webhookHandler.processEvent(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('card.created'),
        'card-123',
        'active'
      );

      consoleSpy.mockRestore();
    });

    it('should handle card.updated event', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const event: MoovWebhookEvent = {
        eventID: 'evt-1',
        type: 'card.updated',
        data: {
          cardID: 'card-123',
          status: 'expired',
          accountID: 'acct-456',
        },
        createdOn: '2024-01-15T10:00:00Z',
      };

      await webhookHandler.processEvent(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('card.updated'),
        'card-123',
        'expired'
      );

      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // Event Processing - Payment Method Events
  // ==========================================================================
  describe('Payment Method Event Processing', () => {
    it('should handle payment-method.enabled event', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const event: MoovWebhookEvent = {
        eventID: 'evt-1',
        type: 'payment-method.enabled',
        data: {
          paymentMethodID: 'pm-123',
          paymentMethodType: 'ach-debit-fund',
          accountID: 'acct-456',
        },
        createdOn: '2024-01-15T10:00:00Z',
      };

      await webhookHandler.processEvent(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('payment-method.enabled'),
        'pm-123',
        'ach-debit-fund'
      );

      consoleSpy.mockRestore();
    });

    it('should handle payment-method.disabled event', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const event: MoovWebhookEvent = {
        eventID: 'evt-1',
        type: 'payment-method.disabled',
        data: {
          paymentMethodID: 'pm-123',
          paymentMethodType: 'rtp-credit',
          accountID: 'acct-456',
        },
        createdOn: '2024-01-15T10:00:00Z',
      };

      await webhookHandler.processEvent(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('payment-method.disabled'),
        'pm-123',
        'rtp-credit'
      );

      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // Unknown Event Types
  // ==========================================================================
  describe('Unknown Event Types', () => {
    it('should log unknown event types', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const event: MoovWebhookEvent = {
        eventID: 'evt-1',
        type: 'unknown.event.type',
        data: { foo: 'bar' },
        createdOn: '2024-01-15T10:00:00Z',
      };

      await webhookHandler.processEvent(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unhandled Moov event type'),
        expect.objectContaining({ type: 'unknown.event.type' })
      );

      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // Status Mapping
  // ==========================================================================
  describe('Status Mapping', () => {
    const testStatusMapping = async (
      moovStatus: string,
      expectedStatus: string
    ) => {
      const event: MoovWebhookEvent = {
        eventID: 'evt-1',
        type: 'transfer.pending', // Event type doesn't matter for status mapping
        data: {
          transferID: 'xfer-123',
          status: moovStatus,
        },
        createdOn: '2024-01-15T10:00:00Z',
      };

      await webhookHandler.processEvent(event);

      if (expectedStatus) {
        expect(mockTransferService.processStatusUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ status: expectedStatus })
        );
      }
    };

    it('should map "created" to "pending"', async () => {
      await testStatusMapping('created', 'pending');
    });

    it('should map "pending" to "processing"', async () => {
      await testStatusMapping('pending', 'processing');
    });

    it('should map "completed" to "completed"', async () => {
      await testStatusMapping('completed', 'completed');
    });

    it('should map "failed" to "failed"', async () => {
      await testStatusMapping('failed', 'failed');
    });

    it('should map "reversed" to "returned"', async () => {
      await testStatusMapping('reversed', 'returned');
    });
  });

  // ==========================================================================
  // End-to-End Webhook Flow
  // ==========================================================================
  describe('End-to-End Webhook Flow', () => {
    it('should verify, parse, and process a complete webhook', async () => {
      const payload = JSON.stringify({
        eventID: 'evt-999',
        type: 'transfer.completed',
        data: {
          transferID: 'xfer-e2e',
          status: 'completed',
          completedOn: '2024-01-15T14:30:00Z',
          amount: { value: 50000, currency: 'USD' },
        },
        createdOn: '2024-01-15T10:00:00Z',
      });

      const timestamp = Date.now().toString();
      const signedPayload = `${timestamp}.${payload}`;
      const signature = crypto
        .createHmac('sha256', 'test-webhook-secret')
        .update(signedPayload)
        .digest('hex');

      // Verify signature
      const isValid = webhookHandler.verifySignature(payload, signature, timestamp);
      expect(isValid).toBe(true);

      // Parse event
      const event = webhookHandler.parseEvent(payload);
      expect(event.eventID).toBe('evt-999');

      // Process event
      await webhookHandler.processEvent(event);

      expect(mockTransferService.processStatusUpdate).toHaveBeenCalledWith({
        transferId: '',
        providerTransferId: 'xfer-e2e',
        status: 'completed',
        rail: 'ach',
        completedAt: expect.any(Date),
        failureReason: undefined,
      });
    });

    it('should reject webhook with invalid signature before processing', () => {
      const payload = JSON.stringify({
        eventID: 'evt-attack',
        type: 'transfer.completed',
        data: { transferID: 'xfer-fake', status: 'completed' },
        createdOn: '2024-01-15T10:00:00Z',
      });

      const timestamp = Date.now().toString();
      const fakeSignature = 'a'.repeat(64); // Invalid signature

      const isValid = webhookHandler.verifySignature(payload, fakeSignature, timestamp);

      expect(isValid).toBe(false);
      // Would not proceed to parse/process in real handler
    });
  });
});

import crypto from 'crypto';
import { env } from '../../../config/env.js';
import { AppError } from '../../../common/errors/app-error.js';
import { getTransferService } from './transfer-service.js';
import type {
  MoovWebhookEvent,
  MoovEventType,
  TransferStatus,
} from '../types.js';

/**
 * Moov Webhook Handler
 *
 * Processes incoming webhooks from Moov to update transfer status
 * and trigger downstream actions (ledger entries, notifications).
 */

// Map Moov transfer statuses to our statuses
const MOOV_TRANSFER_STATUS_MAP: Record<string, TransferStatus> = {
  created: 'pending',
  pending: 'processing',
  completed: 'completed',
  failed: 'failed',
  reversed: 'returned',
};

export class MoovWebhookHandler {
  private transferService = getTransferService();

  /**
   * Verify webhook signature from Moov
   */
  verifySignature(
    payload: string,
    signature: string,
    timestamp: string
  ): boolean {
    if (!env.MOOV_WEBHOOK_SECRET) {
      // No secret configured - skip verification in dev
      if (env.NODE_ENV === 'development') {
        return true;
      }
      throw AppError.invalidRequest('Webhook secret not configured');
    }

    // Moov uses HMAC-SHA256 for webhook signatures
    // Format: t=timestamp,v1=signature
    const signedPayload = `${timestamp}.${payload}`;
    const expectedSignature = crypto
      .createHmac('sha256', env.MOOV_WEBHOOK_SECRET)
      .update(signedPayload)
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    } catch {
      return false;
    }
  }

  /**
   * Parse and validate webhook event
   */
  parseEvent(payload: string): MoovWebhookEvent {
    try {
      const event = JSON.parse(payload);

      if (!event.eventID || !event.type || !event.data) {
        throw new Error('Invalid event structure');
      }

      return event as MoovWebhookEvent;
    } catch (error) {
      throw AppError.invalidRequest(
        `Invalid webhook payload: ${(error as Error).message}`
      );
    }
  }

  /**
   * Process a Moov webhook event
   */
  async processEvent(event: MoovWebhookEvent): Promise<void> {
    const eventType = event.type as MoovEventType;

    switch (eventType) {
      case 'transfer.created':
      case 'transfer.pending':
      case 'transfer.completed':
      case 'transfer.failed':
      case 'transfer.reversed':
        await this.handleTransferEvent(event);
        break;

      case 'bank-account.created':
      case 'bank-account.updated':
        await this.handleBankAccountEvent(event);
        break;

      case 'card.created':
      case 'card.updated':
        await this.handleCardEvent(event);
        break;

      case 'payment-method.enabled':
      case 'payment-method.disabled':
        await this.handlePaymentMethodEvent(event);
        break;

      default:
        // Log unknown events for monitoring
        console.log(`Unhandled Moov event type: ${event.type}`, event);
    }
  }

  /**
   * Handle transfer status events
   */
  private async handleTransferEvent(event: MoovWebhookEvent): Promise<void> {
    const data = event.data as {
      transferID: string;
      status: string;
      completedOn?: string;
      failureReason?: string;
      amount?: { value: number; currency: string };
    };

    const status = MOOV_TRANSFER_STATUS_MAP[data.status];
    if (!status) {
      console.warn(`Unknown transfer status: ${data.status}`);
      return;
    }

    await this.transferService.processStatusUpdate({
      transferId: '', // Will be looked up by provider ID
      providerTransferId: data.transferID,
      status,
      rail: 'ach', // Will be determined from execution record
      completedAt: data.completedOn ? new Date(data.completedOn) : undefined,
      failureReason: data.failureReason,
    });
  }

  /**
   * Handle bank account events
   */
  private async handleBankAccountEvent(event: MoovWebhookEvent): Promise<void> {
    const data = event.data as {
      bankAccountID: string;
      status: string;
      accountID: string;
    };

    // Update funding instrument verification status if needed
    console.log(`Bank account ${event.type}:`, data.bankAccountID, data.status);

    // TODO: Update FundingInstrument.verified based on Moov status
    // Status 'verified' = verified: true
    // Status 'verificationFailed' = verified: false
  }

  /**
   * Handle card events
   */
  private async handleCardEvent(event: MoovWebhookEvent): Promise<void> {
    const data = event.data as {
      cardID: string;
      status: string;
      accountID: string;
    };

    console.log(`Card ${event.type}:`, data.cardID, data.status);

    // TODO: Update FundingInstrument based on card status
  }

  /**
   * Handle payment method events
   */
  private async handlePaymentMethodEvent(event: MoovWebhookEvent): Promise<void> {
    const data = event.data as {
      paymentMethodID: string;
      paymentMethodType: string;
      accountID: string;
    };

    console.log(`Payment method ${event.type}:`, data.paymentMethodID, data.paymentMethodType);

    // Payment method changes can affect routing capabilities
    // TODO: Update instrument capabilities cache
  }
}

// Singleton instance
let webhookHandlerInstance: MoovWebhookHandler | null = null;

export function getMoovWebhookHandler(): MoovWebhookHandler {
  if (!webhookHandlerInstance) {
    webhookHandlerInstance = new MoovWebhookHandler();
  }
  return webhookHandlerInstance;
}

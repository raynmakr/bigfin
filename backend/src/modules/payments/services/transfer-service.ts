import { prisma } from '../../../config/database.js';
import { AppError } from '../../../common/errors/app-error.js';
import { getMoovClient } from './moov-client.js';
import { getRoutingService } from './routing-service.js';
import { LedgerService } from '../../ledger/service.js';
import type {
  PaymentRail,
  PaymentSpeed,
  TransferStatus,
  InitiateTransferInput,
  TransferResult,
  TransferStatusUpdate,
  RoutingDecision,
  InstrumentCapabilities,
} from '../types.js';

/**
 * Transfer Execution Service
 *
 * Orchestrates payment transfers:
 * - Executes transfers via Moov
 * - Handles fallback rails on failure
 * - Updates funds availability
 *
 * Note: This is a simplified version that works with the existing Disbursement/Repayment
 * schema rather than a separate PaymentIntent table.
 */

export class TransferService {
  private moov = getMoovClient();
  private routing = getRoutingService();
  private ledger = new LedgerService(prisma);

  /**
   * Initiate a transfer
   *
   * This method routes and executes the transfer via Moov,
   * returning the transfer details. The caller (disbursement/repayment routes)
   * is responsible for creating and updating their respective records.
   */
  async initiateTransfer(
    tenantId: string,
    input: InitiateTransferInput
  ): Promise<TransferResult> {
    const {
      sourceAccountId,
      destinationAccountId,
      amountCents,
      speed,
      direction,
      description,
      metadata,
    } = input;

    // Get instrument capabilities
    const [sourceInstrument, destInstrument] = await Promise.all([
      this.getInstrumentCapabilities(sourceAccountId),
      this.getInstrumentCapabilities(destinationAccountId),
    ]);

    // Route the payment
    const routingDecision = await this.routing.routePayment({
      speed,
      direction,
      amountCents,
      sourceInstrument,
      destinationInstrument: destInstrument,
    });

    // Execute the transfer
    return this.executeTransfer(
      routingDecision,
      sourceInstrument,
      destInstrument,
      amountCents,
      description,
      metadata
    );
  }

  /**
   * Execute transfer with the selected rail
   */
  private async executeTransfer(
    routing: RoutingDecision,
    source: InstrumentCapabilities,
    destination: InstrumentCapabilities,
    amountCents: number,
    description: string,
    metadata?: Record<string, string>
  ): Promise<TransferResult> {
    let currentRail = routing.rail;
    let lastError: Error | null = null;
    const triedRails: PaymentRail[] = [];

    // Try primary rail, then fallbacks
    const railsToTry = [currentRail, ...routing.fallbackRails];

    for (const rail of railsToTry) {
      if (triedRails.includes(rail)) continue;
      triedRails.push(rail);

      try {
        // Get payment method IDs for source and destination
        const sourcePaymentMethodId = await this.getPaymentMethodId(source.id, rail, 'source');
        const destPaymentMethodId = await this.getPaymentMethodId(destination.id, rail, 'destination');

        // Create transfer via Moov
        const transfer = await this.moov.createTransfer({
          sourceAccountId: source.id,
          sourcePaymentMethodId,
          destinationAccountId: destination.id,
          destinationPaymentMethodId: destPaymentMethodId,
          amountCents,
          description,
          metadata: {
            rail,
            ...metadata,
          },
        });

        return {
          id: transfer.transferID,
          providerTransferId: transfer.transferID,
          rail,
          status: 'processing',
          amountCents,
          feeCents: routing.fee,
          estimatedArrival: routing.estimatedArrival,
          initiatedAt: new Date(),
        };
      } catch (error) {
        lastError = error as Error;
        // Continue to next rail
        continue;
      }
    }

    // All rails failed
    throw AppError.providerError(
      `Transfer failed on all rails (${triedRails.join(', ')}): ${lastError?.message}`
    );
  }

  /**
   * Get appropriate payment method ID for a rail
   */
  private async getPaymentMethodId(
    instrumentId: string,
    rail: PaymentRail,
    role: 'source' | 'destination'
  ): Promise<string> {
    // Get funding instrument
    const instrument = await prisma.fundingInstrument.findUnique({
      where: { id: instrumentId },
    });

    if (!instrument || !instrument.providerRef) {
      // Return a mock payment method ID for testing
      return `pm-${rail}-${instrumentId}`;
    }

    // Get payment methods from Moov
    const paymentMethods = await this.moov.listPaymentMethods(instrument.providerRef);

    // Find matching payment method for the rail
    const targetTypes = this.getPaymentMethodTypesForRail(rail, role);

    const matched = paymentMethods.find((pm) =>
      targetTypes.includes(pm.paymentMethodType)
    );

    if (!matched) {
      // Return a mock payment method ID for testing
      return `pm-${rail}-${instrumentId}`;
    }

    return matched.paymentMethodID;
  }

  /**
   * Get Moov payment method types for a rail
   */
  private getPaymentMethodTypesForRail(
    rail: PaymentRail,
    role: 'source' | 'destination'
  ): string[] {
    switch (rail) {
      case 'rtp':
        return ['rtp-credit'];
      case 'fednow':
        return ['fednow-credit'];
      case 'push_to_card':
        return ['push-to-card'];
      case 'same_day_ach':
        return role === 'source'
          ? ['ach-debit-fund', 'ach-debit-collect']
          : ['ach-credit-same-day'];
      case 'ach':
      default:
        return role === 'source'
          ? ['ach-debit-fund', 'ach-debit-collect']
          : ['ach-credit-standard'];
    }
  }

  /**
   * Get instrument capabilities for routing
   */
  private async getInstrumentCapabilities(
    instrumentId: string
  ): Promise<InstrumentCapabilities> {
    const instrument = await prisma.fundingInstrument.findUnique({
      where: { id: instrumentId },
    });

    if (!instrument) {
      throw AppError.notFound('Funding instrument');
    }

    const isVerified = instrument.status === 'VERIFIED';

    // Determine supported rails based on instrument type and verification
    let supportedRails: PaymentRail[] = [];

    if (instrument.type === 'BANK_ACCOUNT') {
      if (isVerified) {
        // Verified bank accounts support all rails
        supportedRails = ['rtp', 'fednow', 'same_day_ach', 'ach'];
      } else {
        // Unverified only get ACH
        supportedRails = ['ach'];
      }
    } else if (instrument.type === 'DEBIT_CARD') {
      supportedRails = ['push_to_card'];
    }

    return {
      id: instrumentId,
      type: instrument.type === 'BANK_ACCOUNT' ? 'bank_account' : 'debit_card',
      supportedRails,
      verified: isVerified,
    };
  }

  /**
   * Process a transfer status update (from webhook)
   */
  async processStatusUpdate(update: TransferStatusUpdate): Promise<void> {
    // Find disbursement or repayment with this provider reference
    const disbursement = await prisma.disbursement.findFirst({
      where: { providerRef: update.providerTransferId },
    });

    if (disbursement) {
      await this.updateDisbursementStatus(disbursement.id, update);
      return;
    }

    const repayment = await prisma.repayment.findFirst({
      where: { providerRef: update.providerTransferId },
    });

    if (repayment) {
      await this.updateRepaymentStatus(repayment.id, update);
      return;
    }

    // Unknown transfer - log and skip
    console.warn(`Unknown transfer: ${update.providerTransferId}`);
  }

  /**
   * Update disbursement status based on transfer status
   */
  private async updateDisbursementStatus(
    disbursementId: string,
    update: TransferStatusUpdate
  ): Promise<void> {
    const statusMap: Record<TransferStatus, string> = {
      pending: 'PENDING',
      processing: 'PENDING',
      completed: 'COMPLETED',
      failed: 'FAILED',
      returned: 'FAILED',
      canceled: 'FAILED',
    };

    const availabilityMap: Record<TransferStatus, string> = {
      pending: 'PENDING',
      processing: 'PENDING',
      completed: 'AVAILABLE',
      failed: 'FAILED',
      returned: 'FAILED',
      canceled: 'FAILED',
    };

    await prisma.disbursement.update({
      where: { id: disbursementId },
      data: {
        status: statusMap[update.status] as any,
        availabilityState: availabilityMap[update.status] as any,
        completedAt: update.status === 'completed' ? new Date() : undefined,
        failedAt: update.status === 'failed' || update.status === 'returned' ? new Date() : undefined,
        failureReason: update.failureReason,
      },
    });

    // If completed, update the contract status
    if (update.status === 'completed') {
      const disbursement = await prisma.disbursement.findUnique({
        where: { id: disbursementId },
        include: { contract: true },
      });

      if (disbursement) {
        await prisma.loanContract.update({
          where: { id: disbursement.contractId },
          data: {
            status: 'ACTIVE',
            disbursedAt: new Date(),
          },
        });
      }
    }
  }

  /**
   * Update repayment status based on transfer status
   */
  private async updateRepaymentStatus(
    repaymentId: string,
    update: TransferStatusUpdate
  ): Promise<void> {
    const statusMap: Record<TransferStatus, string> = {
      pending: 'PENDING',
      processing: 'PENDING',
      completed: 'COMPLETED',
      failed: 'FAILED',
      returned: 'RETURNED',
      canceled: 'CANCELLED',
    };

    const availabilityMap: Record<TransferStatus, string> = {
      pending: 'PENDING',
      processing: 'PENDING',
      completed: 'AVAILABLE',
      failed: 'FAILED',
      returned: 'FAILED',
      canceled: 'FAILED',
    };

    await prisma.repayment.update({
      where: { id: repaymentId },
      data: {
        status: statusMap[update.status] as any,
        availabilityState: availabilityMap[update.status] as any,
        completedAt: update.status === 'completed' ? new Date() : undefined,
        failedAt: update.status === 'failed' ? new Date() : undefined,
        returnedAt: update.status === 'returned' ? new Date() : undefined,
        failureReason: update.failureReason,
      },
    });
  }

  /**
   * Get transfer status by provider reference
   */
  async getTransfer(
    tenantId: string,
    providerRef: string
  ): Promise<TransferResult | null> {
    // Check disbursements
    const disbursement = await prisma.disbursement.findFirst({
      where: {
        providerRef,
        contract: { tenantId },
      },
    });

    if (disbursement) {
      return {
        id: disbursement.id,
        providerTransferId: disbursement.providerRef || '',
        rail: (disbursement.rail?.toLowerCase() as PaymentRail) || 'ach',
        status: disbursement.status.toLowerCase() as TransferStatus,
        amountCents: disbursement.amountCents,
        feeCents: disbursement.expressFeeCents,
        estimatedArrival: disbursement.availableAt || new Date(),
        initiatedAt: disbursement.initiatedAt,
        completedAt: disbursement.completedAt || undefined,
        failureReason: disbursement.failureReason || undefined,
      };
    }

    // Check repayments
    const repayment = await prisma.repayment.findFirst({
      where: {
        providerRef,
        contract: { tenantId },
      },
    });

    if (repayment) {
      return {
        id: repayment.id,
        providerTransferId: repayment.providerRef || '',
        rail: (repayment.rail?.toLowerCase() as PaymentRail) || 'ach',
        status: repayment.status.toLowerCase() as TransferStatus,
        amountCents: repayment.amountCents,
        feeCents: 0,
        estimatedArrival: repayment.availableAt || new Date(),
        initiatedAt: repayment.initiatedAt || new Date(),
        completedAt: repayment.completedAt || undefined,
        failureReason: repayment.failureReason || undefined,
      };
    }

    return null;
  }

  /**
   * Cancel a pending transfer
   */
  async cancelTransfer(
    tenantId: string,
    providerRef: string
  ): Promise<void> {
    // Try to cancel with Moov
    try {
      await this.moov.cancelTransfer(providerRef);
    } catch (error) {
      // Provider may not support cancellation
      console.warn(`Could not cancel transfer with provider: ${(error as Error).message}`);
    }
  }
}

// Singleton instance
let transferServiceInstance: TransferService | null = null;

export function getTransferService(): TransferService {
  if (!transferServiceInstance) {
    transferServiceInstance = new TransferService();
  }
  return transferServiceInstance;
}

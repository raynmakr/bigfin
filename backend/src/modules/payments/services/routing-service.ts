import { prisma } from '../../../config/database.js';
import { AppError } from '../../../common/errors/app-error.js';
import type {
  PaymentRail,
  PaymentSpeed,
  PaymentDirection,
  RoutingDecision,
  RoutingInput,
  InstrumentCapabilities,
} from '../types.js';

/**
 * Payment Routing Service
 *
 * Determines the optimal payment rail based on:
 * - Requested speed (standard vs instant)
 * - Source/destination instrument capabilities
 * - Amount (for fee calculation)
 * - Prefund status (for fee waiver)
 *
 * Priority order for instant: RTP → FedNow → push-to-card → same_day_ach → ach
 * Standard always uses: ach
 */

// Rail priority for instant payments (highest to lowest)
const INSTANT_RAIL_PRIORITY: PaymentRail[] = [
  'rtp',
  'fednow',
  'push_to_card',
  'same_day_ach',
  'ach',
];

// Standard payments always use ACH
const STANDARD_RAIL: PaymentRail = 'ach';

// Express fee bands (from fees_policy.json)
const EXPRESS_FEE_BANDS = [
  { minCents: 10000, maxCents: 50000, feeCents: 299 },
  { minCents: 50001, maxCents: 200000, feeCents: 499 },
  { minCents: 200001, maxCents: 500000, feeCents: 799 },
  { minCents: 500001, maxCents: 1000000, feeCents: 999 },
  { minCents: 1000001, maxCents: 2500000, feeCents: 1499 },
  { minCents: 2500001, maxCents: 5000000, feeCents: 1999 },
];

// Estimated arrival times by rail
const ARRIVAL_ESTIMATES: Record<PaymentRail, { hours: number; businessDaysOnly: boolean }> = {
  rtp: { hours: 0, businessDaysOnly: false },
  fednow: { hours: 0, businessDaysOnly: false },
  push_to_card: { hours: 0.5, businessDaysOnly: false },
  same_day_ach: { hours: 4, businessDaysOnly: true },
  ach: { hours: 24, businessDaysOnly: true },
};

// Fallback rails when primary fails
const FALLBACK_CHAIN: Record<PaymentRail, PaymentRail | null> = {
  rtp: 'fednow',
  fednow: 'push_to_card',
  push_to_card: 'ach',
  same_day_ach: 'ach',
  ach: null,
};

export class PaymentRoutingService {
  /**
   * Determine the optimal payment rail for a transfer
   */
  async routePayment(input: RoutingInput): Promise<RoutingDecision> {
    const { speed, direction, amountCents, sourceInstrument, destinationInstrument } = input;

    // Validate amount
    if (amountCents <= 0) {
      throw AppError.invalidRequest('Amount must be positive');
    }

    // Get available rails based on instruments
    const availableRails = this.getAvailableRails(
      sourceInstrument,
      destinationInstrument,
      direction
    );

    if (availableRails.length === 0) {
      throw AppError.invalidRequest('No payment rails available for this instrument combination');
    }

    // Select rail based on speed preference
    let selectedRail: PaymentRail;
    let reason: string;

    if (speed === 'standard') {
      // Standard always uses ACH if available
      if (availableRails.includes('ach')) {
        selectedRail = 'ach';
        reason = 'Standard speed requested; using ACH';
      } else {
        throw AppError.invalidRequest('ACH not available for this instrument');
      }
    } else {
      // Instant: try rails in priority order
      const instantResult = this.selectInstantRail(availableRails);
      selectedRail = instantResult.rail;
      reason = instantResult.reason;
    }

    // Calculate fee
    const fee = this.calculateFee(speed, amountCents);

    // Calculate estimated arrival
    const estimatedArrival = this.calculateEstimatedArrival(selectedRail);

    // Build fallback chain
    const fallbackRails = this.buildFallbackChain(selectedRail, availableRails);

    return {
      rail: selectedRail,
      estimatedArrival,
      fee,
      fallbackRails,
      reason,
    };
  }

  /**
   * Get rails available for the given instruments and direction
   */
  private getAvailableRails(
    source: InstrumentCapabilities,
    destination: InstrumentCapabilities | undefined,
    direction: PaymentDirection
  ): PaymentRail[] {
    // For credits (disbursements), we care about destination capabilities
    // For debits (repayments), we care about source capabilities
    const relevantInstrument = direction === 'credit' ? (destination || source) : source;

    // If instrument has explicit supported rails, use those
    if (relevantInstrument.supportedRails.length > 0) {
      return relevantInstrument.supportedRails;
    }

    // Default rails by instrument type
    if (relevantInstrument.type === 'bank_account') {
      if (relevantInstrument.verified) {
        // Verified bank accounts support all ACH rails
        // RTP/FedNow availability depends on the bank - assume available for now
        return ['rtp', 'fednow', 'same_day_ach', 'ach'];
      } else {
        // Unverified accounts only get standard ACH
        return ['ach'];
      }
    }

    if (relevantInstrument.type === 'debit_card') {
      // Debit cards support push-to-card and card payments
      return ['push_to_card'];
    }

    // Fallback to ACH
    return ['ach'];
  }

  /**
   * Select the best instant rail from available options
   */
  private selectInstantRail(
    availableRails: PaymentRail[]
  ): { rail: PaymentRail; reason: string } {
    // Try rails in priority order
    for (const rail of INSTANT_RAIL_PRIORITY) {
      if (availableRails.includes(rail)) {
        const reasons: Record<PaymentRail, string> = {
          rtp: 'RTP available; using fastest rail',
          fednow: 'FedNow available; RTP not supported',
          push_to_card: 'Push-to-card available; real-time rails not supported',
          same_day_ach: 'Same-day ACH available; faster rails not supported',
          ach: 'Standard ACH; no instant rails available',
        };
        return { rail, reason: reasons[rail] };
      }
    }

    // Should never reach here if availableRails is non-empty
    return { rail: 'ach', reason: 'Fallback to ACH' };
  }

  /**
   * Calculate express fee based on amount
   */
  calculateFee(speed: PaymentSpeed, amountCents: number): number {
    // No fee for standard speed
    if (speed === 'standard') {
      return 0;
    }

    // Find applicable fee band
    for (const band of EXPRESS_FEE_BANDS) {
      if (amountCents >= band.minCents && amountCents <= band.maxCents) {
        return band.feeCents;
      }
    }

    // Below minimum or above maximum
    const firstBand = EXPRESS_FEE_BANDS[0];
    const lastBand = EXPRESS_FEE_BANDS[EXPRESS_FEE_BANDS.length - 1];

    if (firstBand && amountCents < firstBand.minCents) {
      return firstBand.feeCents;
    }

    return lastBand?.feeCents ?? 1999;
  }

  /**
   * Check if express fee should be waived due to prefund
   */
  async checkPrefundWaiver(
    tenantId: string,
    lenderId: string,
    principalCents: number
  ): Promise<{ waived: boolean; reason: string }> {
    // Get lender's most recent prefund transaction to determine balance
    const latestPrefundTx = await prisma.prefundTransaction.findFirst({
      where: {
        customerId: lenderId,
        customer: { tenantId },
        status: 'COMPLETED',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!latestPrefundTx) {
      return { waived: false, reason: 'No prefund balance' };
    }

    const availableBalance = latestPrefundTx.availableAfterCents;

    // Waiver requires 100% of principal covered by prefund
    if (availableBalance >= principalCents) {
      return {
        waived: true,
        reason: `Prefund balance ($${(availableBalance / 100).toFixed(2)}) covers principal`,
      };
    }

    return {
      waived: false,
      reason: `Prefund balance ($${(availableBalance / 100).toFixed(2)}) insufficient for principal ($${(principalCents / 100).toFixed(2)})`,
    };
  }

  /**
   * Calculate estimated arrival time based on rail
   */
  private calculateEstimatedArrival(rail: PaymentRail): Date {
    const estimate = ARRIVAL_ESTIMATES[rail];
    const now = new Date();

    if (estimate.hours === 0) {
      // Immediate
      return now;
    }

    if (estimate.businessDaysOnly) {
      return this.addBusinessHours(now, estimate.hours);
    }

    return new Date(now.getTime() + estimate.hours * 60 * 60 * 1000);
  }

  /**
   * Add business hours to a date (skipping weekends)
   */
  private addBusinessHours(date: Date, hours: number): Date {
    const result = new Date(date);
    let remainingHours = hours;

    while (remainingHours > 0) {
      result.setHours(result.getHours() + 1);
      const dayOfWeek = result.getDay();

      // Skip weekends (0 = Sunday, 6 = Saturday)
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        const hour = result.getHours();
        // Only count business hours (9 AM - 5 PM)
        if (hour >= 9 && hour < 17) {
          remainingHours--;
        }
      }
    }

    return result;
  }

  /**
   * Build fallback chain for a rail
   */
  private buildFallbackChain(
    primaryRail: PaymentRail,
    availableRails: PaymentRail[]
  ): PaymentRail[] {
    const fallbacks: PaymentRail[] = [];
    let currentRail: PaymentRail | null = FALLBACK_CHAIN[primaryRail];

    while (currentRail) {
      if (availableRails.includes(currentRail)) {
        fallbacks.push(currentRail);
      }
      currentRail = FALLBACK_CHAIN[currentRail];
    }

    return fallbacks;
  }

  /**
   * Get routing options for display (both standard and instant)
   */
  async getRoutingOptions(input: Omit<RoutingInput, 'speed'>): Promise<{
    standard: RoutingDecision;
    instant: RoutingDecision | null;
    instantAvailable: boolean;
  }> {
    // Get standard routing
    const standard = await this.routePayment({ ...input, speed: 'standard' });

    // Try instant routing
    let instant: RoutingDecision | null = null;
    let instantAvailable = false;

    try {
      instant = await this.routePayment({ ...input, speed: 'instant' });
      // Instant is only truly available if we got a non-ACH rail
      instantAvailable = instant.rail !== 'ach';
    } catch {
      // Instant not available
    }

    return { standard, instant, instantAvailable };
  }
}

// Singleton instance
let routingServiceInstance: PaymentRoutingService | null = null;

export function getRoutingService(): PaymentRoutingService {
  if (!routingServiceInstance) {
    routingServiceInstance = new PaymentRoutingService();
  }
  return routingServiceInstance;
}

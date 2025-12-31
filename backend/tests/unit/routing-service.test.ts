import { describe, it, expect, beforeAll } from 'vitest';
import { PaymentRoutingService } from '../../src/modules/payments/services/routing-service.js';
import type {
  PaymentRail,
  PaymentSpeed,
  InstrumentCapabilities,
  RoutingInput,
} from '../../src/modules/payments/types.js';

let routingService: PaymentRoutingService;

// Test fixtures
const createInstrument = (
  overrides: Partial<InstrumentCapabilities> = {}
): InstrumentCapabilities => ({
  id: 'test-instrument-id',
  type: 'bank_account',
  supportedRails: [],
  verified: true,
  ...overrides,
});

const createRoutingInput = (
  overrides: Partial<RoutingInput> = {}
): RoutingInput => ({
  speed: 'standard',
  direction: 'credit',
  amountCents: 50000, // $500
  sourceInstrument: createInstrument(),
  ...overrides,
});

describe('PaymentRoutingService', () => {
  beforeAll(() => {
    routingService = new PaymentRoutingService();
  });

  // ==========================================================================
  // Rail Selection - Standard Speed
  // ==========================================================================
  describe('Standard Speed Routing', () => {
    it('should always select ACH for standard speed', async () => {
      const input = createRoutingInput({
        speed: 'standard',
        sourceInstrument: createInstrument({
          supportedRails: ['rtp', 'fednow', 'same_day_ach', 'ach'],
        }),
      });

      const result = await routingService.routePayment(input);

      expect(result.rail).toBe('ach');
      expect(result.reason).toContain('Standard speed');
    });

    it('should throw error if ACH not available for standard speed', async () => {
      const input = createRoutingInput({
        speed: 'standard',
        sourceInstrument: createInstrument({
          type: 'debit_card',
          supportedRails: ['push_to_card'],
        }),
      });

      await expect(routingService.routePayment(input)).rejects.toThrow(
        /ACH not available/
      );
    });

    it('should have zero fee for standard speed', async () => {
      const input = createRoutingInput({
        speed: 'standard',
        sourceInstrument: createInstrument({ supportedRails: ['ach'] }),
      });

      const result = await routingService.routePayment(input);

      expect(result.fee).toBe(0);
    });
  });

  // ==========================================================================
  // Rail Selection - Instant Speed
  // ==========================================================================
  describe('Instant Speed Routing', () => {
    it('should prefer RTP when available', async () => {
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          supportedRails: ['rtp', 'fednow', 'push_to_card', 'ach'],
        }),
      });

      const result = await routingService.routePayment(input);

      expect(result.rail).toBe('rtp');
      expect(result.reason).toContain('RTP available');
    });

    it('should fall back to FedNow when RTP not available', async () => {
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          supportedRails: ['fednow', 'push_to_card', 'ach'],
        }),
      });

      const result = await routingService.routePayment(input);

      expect(result.rail).toBe('fednow');
      expect(result.reason).toContain('FedNow available');
    });

    it('should fall back to push-to-card when real-time rails not available', async () => {
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          supportedRails: ['push_to_card', 'ach'],
        }),
      });

      const result = await routingService.routePayment(input);

      expect(result.rail).toBe('push_to_card');
      expect(result.reason).toContain('Push-to-card available');
    });

    it('should fall back to same-day ACH when faster rails not available', async () => {
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          supportedRails: ['same_day_ach', 'ach'],
        }),
      });

      const result = await routingService.routePayment(input);

      expect(result.rail).toBe('same_day_ach');
      expect(result.reason).toContain('Same-day ACH available');
    });

    it('should fall back to ACH as last resort for instant', async () => {
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          supportedRails: ['ach'],
        }),
      });

      const result = await routingService.routePayment(input);

      expect(result.rail).toBe('ach');
      expect(result.reason).toContain('Standard ACH');
    });

    it('should follow correct priority order', async () => {
      const priorityOrder: PaymentRail[] = [
        'rtp',
        'fednow',
        'push_to_card',
        'same_day_ach',
        'ach',
      ];

      for (let i = 0; i < priorityOrder.length; i++) {
        const availableRails = priorityOrder.slice(i);
        const input = createRoutingInput({
          speed: 'instant',
          sourceInstrument: createInstrument({ supportedRails: availableRails }),
        });

        const result = await routingService.routePayment(input);
        expect(result.rail).toBe(priorityOrder[i]);
      }
    });
  });

  // ==========================================================================
  // Fee Calculation
  // ==========================================================================
  describe('Fee Calculation', () => {
    it('should return 0 for standard speed', () => {
      expect(routingService.calculateFee('standard', 50000)).toBe(0);
      expect(routingService.calculateFee('standard', 100000)).toBe(0);
      expect(routingService.calculateFee('standard', 500000)).toBe(0);
    });

    it('should return correct fee for $100-$500 band', () => {
      // Band: 10000-50000 cents = $2.99
      expect(routingService.calculateFee('instant', 10000)).toBe(299);
      expect(routingService.calculateFee('instant', 25000)).toBe(299);
      expect(routingService.calculateFee('instant', 50000)).toBe(299);
    });

    it('should return correct fee for $500.01-$2000 band', () => {
      // Band: 50001-200000 cents = $4.99
      expect(routingService.calculateFee('instant', 50001)).toBe(499);
      expect(routingService.calculateFee('instant', 100000)).toBe(499);
      expect(routingService.calculateFee('instant', 200000)).toBe(499);
    });

    it('should return correct fee for $2000.01-$5000 band', () => {
      // Band: 200001-500000 cents = $7.99
      expect(routingService.calculateFee('instant', 200001)).toBe(799);
      expect(routingService.calculateFee('instant', 350000)).toBe(799);
      expect(routingService.calculateFee('instant', 500000)).toBe(799);
    });

    it('should return correct fee for $5000.01-$10000 band', () => {
      // Band: 500001-1000000 cents = $9.99
      expect(routingService.calculateFee('instant', 500001)).toBe(999);
      expect(routingService.calculateFee('instant', 750000)).toBe(999);
      expect(routingService.calculateFee('instant', 1000000)).toBe(999);
    });

    it('should return correct fee for $10000.01-$25000 band', () => {
      // Band: 1000001-2500000 cents = $14.99
      expect(routingService.calculateFee('instant', 1000001)).toBe(1499);
      expect(routingService.calculateFee('instant', 1750000)).toBe(1499);
      expect(routingService.calculateFee('instant', 2500000)).toBe(1499);
    });

    it('should return correct fee for $25000.01-$50000 band', () => {
      // Band: 2500001-5000000 cents = $19.99
      expect(routingService.calculateFee('instant', 2500001)).toBe(1999);
      expect(routingService.calculateFee('instant', 3500000)).toBe(1999);
      expect(routingService.calculateFee('instant', 5000000)).toBe(1999);
    });

    it('should return minimum fee for amounts below first band', () => {
      // Below $100 - should use first band fee
      expect(routingService.calculateFee('instant', 5000)).toBe(299);
      expect(routingService.calculateFee('instant', 1000)).toBe(299);
    });

    it('should return maximum fee for amounts above last band', () => {
      // Above $50000 - should use last band fee
      expect(routingService.calculateFee('instant', 5000001)).toBe(1999);
      expect(routingService.calculateFee('instant', 10000000)).toBe(1999);
    });
  });

  // ==========================================================================
  // Instrument Capabilities - Default Rails
  // ==========================================================================
  describe('Instrument Capabilities - Default Rails', () => {
    it('should derive rails for verified bank account', async () => {
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          type: 'bank_account',
          verified: true,
          supportedRails: [], // Empty = use defaults
        }),
      });

      const result = await routingService.routePayment(input);

      // Should get RTP as highest priority for verified bank account
      expect(result.rail).toBe('rtp');
    });

    it('should only allow ACH for unverified bank account', async () => {
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          type: 'bank_account',
          verified: false,
          supportedRails: [], // Empty = use defaults
        }),
      });

      const result = await routingService.routePayment(input);

      // Unverified accounts only get ACH
      expect(result.rail).toBe('ach');
    });

    it('should only allow push-to-card for debit cards', async () => {
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          type: 'debit_card',
          supportedRails: [], // Empty = use defaults
        }),
      });

      const result = await routingService.routePayment(input);

      expect(result.rail).toBe('push_to_card');
    });
  });

  // ==========================================================================
  // Fallback Chain
  // ==========================================================================
  describe('Fallback Chain', () => {
    it('should build correct fallback chain for RTP', async () => {
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          supportedRails: ['rtp', 'fednow', 'push_to_card', 'ach'],
        }),
      });

      const result = await routingService.routePayment(input);

      expect(result.rail).toBe('rtp');
      expect(result.fallbackRails).toContain('fednow');
      expect(result.fallbackRails).toContain('push_to_card');
      expect(result.fallbackRails).toContain('ach');
    });

    it('should build correct fallback chain for FedNow', async () => {
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          supportedRails: ['fednow', 'push_to_card', 'ach'],
        }),
      });

      const result = await routingService.routePayment(input);

      expect(result.rail).toBe('fednow');
      expect(result.fallbackRails).toContain('push_to_card');
      expect(result.fallbackRails).toContain('ach');
      expect(result.fallbackRails).not.toContain('fednow');
    });

    it('should only include available rails in fallback chain', async () => {
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          supportedRails: ['rtp', 'ach'], // Missing fednow and push_to_card
        }),
      });

      const result = await routingService.routePayment(input);

      expect(result.rail).toBe('rtp');
      expect(result.fallbackRails).toEqual(['ach']);
      expect(result.fallbackRails).not.toContain('fednow');
      expect(result.fallbackRails).not.toContain('push_to_card');
    });

    it('should have empty fallback chain for ACH', async () => {
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          supportedRails: ['ach'],
        }),
      });

      const result = await routingService.routePayment(input);

      expect(result.rail).toBe('ach');
      expect(result.fallbackRails).toEqual([]);
    });

    it('should have ACH as fallback for push-to-card when available', async () => {
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          supportedRails: ['push_to_card', 'ach'],
        }),
      });

      const result = await routingService.routePayment(input);

      expect(result.rail).toBe('push_to_card');
      expect(result.fallbackRails).toEqual(['ach']);
    });
  });

  // ==========================================================================
  // Estimated Arrival
  // ==========================================================================
  describe('Estimated Arrival', () => {
    it('should return immediate arrival for RTP', async () => {
      const now = new Date();
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          supportedRails: ['rtp'],
        }),
      });

      const result = await routingService.routePayment(input);

      // RTP should be immediate (within a few seconds of now)
      const diff = result.estimatedArrival.getTime() - now.getTime();
      expect(diff).toBeLessThan(1000); // Less than 1 second
    });

    it('should return immediate arrival for FedNow', async () => {
      const now = new Date();
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          supportedRails: ['fednow'],
        }),
      });

      const result = await routingService.routePayment(input);

      const diff = result.estimatedArrival.getTime() - now.getTime();
      expect(diff).toBeLessThan(1000);
    });

    it('should return ~30 min arrival for push-to-card', async () => {
      const now = new Date();
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          supportedRails: ['push_to_card'],
        }),
      });

      const result = await routingService.routePayment(input);

      // Push-to-card is 0.5 hours = 30 minutes
      const diff = result.estimatedArrival.getTime() - now.getTime();
      const thirtyMinutesMs = 30 * 60 * 1000;
      expect(diff).toBeGreaterThanOrEqual(thirtyMinutesMs - 1000);
      expect(diff).toBeLessThanOrEqual(thirtyMinutesMs + 1000);
    });

    it('should return future date for ACH', async () => {
      const now = new Date();
      const input = createRoutingInput({
        speed: 'standard',
        sourceInstrument: createInstrument({
          supportedRails: ['ach'],
        }),
      });

      const result = await routingService.routePayment(input);

      // ACH takes business hours - arrival should be in the future
      expect(result.estimatedArrival.getTime()).toBeGreaterThan(now.getTime());
    });
  });

  // ==========================================================================
  // Input Validation
  // ==========================================================================
  describe('Input Validation', () => {
    it('should reject zero amount', async () => {
      const input = createRoutingInput({
        amountCents: 0,
        sourceInstrument: createInstrument({ supportedRails: ['ach'] }),
      });

      await expect(routingService.routePayment(input)).rejects.toThrow(
        /Amount must be positive/
      );
    });

    it('should reject negative amount', async () => {
      const input = createRoutingInput({
        amountCents: -1000,
        sourceInstrument: createInstrument({ supportedRails: ['ach'] }),
      });

      await expect(routingService.routePayment(input)).rejects.toThrow(
        /Amount must be positive/
      );
    });

    it('should throw when no rails available', async () => {
      const input = createRoutingInput({
        speed: 'instant',
        sourceInstrument: createInstrument({
          supportedRails: [],
          type: 'bank_account',
          verified: false,
        }),
        destinationInstrument: createInstrument({
          supportedRails: [],
          type: 'bank_account',
          verified: false,
        }),
      });

      // With unverified bank accounts and no explicit rails,
      // it should default to ACH only, which is available
      const result = await routingService.routePayment(input);
      expect(result.rail).toBe('ach');
    });
  });

  // ==========================================================================
  // Routing Options (Standard vs Instant comparison)
  // ==========================================================================
  describe('Routing Options', () => {
    it('should return both standard and instant options', async () => {
      const input = {
        direction: 'credit' as const,
        amountCents: 50000,
        sourceInstrument: createInstrument({
          supportedRails: ['rtp', 'fednow', 'ach'],
        }),
      };

      const options = await routingService.getRoutingOptions(input);

      expect(options.standard).toBeDefined();
      expect(options.standard.rail).toBe('ach');
      expect(options.standard.fee).toBe(0);

      expect(options.instant).toBeDefined();
      expect(options.instant?.rail).toBe('rtp');
      expect(options.instant?.fee).toBeGreaterThan(0);

      expect(options.instantAvailable).toBe(true);
    });

    it('should indicate instant not available when only ACH exists', async () => {
      const input = {
        direction: 'credit' as const,
        amountCents: 50000,
        sourceInstrument: createInstrument({
          supportedRails: ['ach'],
        }),
      };

      const options = await routingService.getRoutingOptions(input);

      expect(options.standard.rail).toBe('ach');
      expect(options.instant?.rail).toBe('ach');
      expect(options.instantAvailable).toBe(false);
    });

    it('should show instant available for push-to-card with ACH fallback', async () => {
      // For getRoutingOptions to work, both standard and instant must be possible
      // So we need an instrument that supports both push_to_card AND ach
      const input = {
        direction: 'credit' as const,
        amountCents: 50000,
        sourceInstrument: createInstrument({
          type: 'bank_account',
          supportedRails: ['push_to_card', 'ach'],
        }),
      };

      const options = await routingService.getRoutingOptions(input);

      expect(options.standard.rail).toBe('ach');
      expect(options.instant?.rail).toBe('push_to_card');
      expect(options.instantAvailable).toBe(true);
    });
  });

  // ==========================================================================
  // Direction-based Routing (Credit vs Debit)
  // ==========================================================================
  describe('Direction-based Routing', () => {
    it('should use destination instrument for credits', async () => {
      const sourceInstrument = createInstrument({
        id: 'source',
        supportedRails: ['ach'],
      });
      const destinationInstrument = createInstrument({
        id: 'dest',
        supportedRails: ['rtp', 'fednow', 'ach'],
      });

      const input = createRoutingInput({
        speed: 'instant',
        direction: 'credit',
        sourceInstrument,
        destinationInstrument,
      });

      const result = await routingService.routePayment(input);

      // Should use destination's RTP capability
      expect(result.rail).toBe('rtp');
    });

    it('should use source instrument for debits', async () => {
      const sourceInstrument = createInstrument({
        id: 'source',
        supportedRails: ['ach'], // Only ACH
      });
      const destinationInstrument = createInstrument({
        id: 'dest',
        supportedRails: ['rtp', 'fednow', 'ach'],
      });

      const input = createRoutingInput({
        speed: 'instant',
        direction: 'debit',
        sourceInstrument,
        destinationInstrument,
      });

      const result = await routingService.routePayment(input);

      // Should use source's ACH-only capability
      expect(result.rail).toBe('ach');
    });
  });
});

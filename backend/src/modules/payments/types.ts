// ============================================================================
// Payment Types
// ============================================================================

export type PaymentRail = 'ach' | 'same_day_ach' | 'rtp' | 'fednow' | 'push_to_card';

export type PaymentSpeed = 'standard' | 'instant';

export type PaymentDirection = 'credit' | 'debit';

export type TransferStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'returned'
  | 'canceled';

export type AvailabilityState =
  | 'initiated'
  | 'pending'
  | 'received'
  | 'held'
  | 'available'
  | 'failed';

// ============================================================================
// Routing Types
// ============================================================================

export interface RoutingDecision {
  rail: PaymentRail;
  estimatedArrival: Date;
  fee: number;
  fallbackRails: PaymentRail[];
  reason: string;
}

export interface RoutingInput {
  speed: PaymentSpeed;
  direction: PaymentDirection;
  amountCents: number;
  sourceInstrument: InstrumentCapabilities;
  destinationInstrument?: InstrumentCapabilities;
}

export interface InstrumentCapabilities {
  id: string;
  type: 'bank_account' | 'debit_card';
  supportedRails: PaymentRail[];
  verified: boolean;
}

// ============================================================================
// Transfer Types
// ============================================================================

export interface InitiateTransferInput {
  contractId?: string;
  sourceAccountId: string;
  destinationAccountId: string;
  amountCents: number;
  speed: PaymentSpeed;
  direction: PaymentDirection;
  description: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface TransferResult {
  id: string;
  providerTransferId: string;
  rail: PaymentRail;
  status: TransferStatus;
  amountCents: number;
  feeCents: number;
  estimatedArrival: Date;
  initiatedAt: Date;
  completedAt?: Date;
  failureReason?: string;
}

export interface TransferStatusUpdate {
  transferId: string;
  providerTransferId: string;
  status: TransferStatus;
  rail: PaymentRail;
  completedAt?: Date;
  failureCode?: string;
  failureReason?: string;
  returnCode?: string;
  returnReason?: string;
}

// ============================================================================
// Moov-Specific Types
// ============================================================================

export interface MoovAccount {
  accountID: string;
  accountType: 'individual' | 'business';
  displayName: string;
  profile?: {
    individual?: {
      name: { firstName: string; lastName: string };
      email: string;
      phone?: { number: string };
    };
    business?: {
      legalBusinessName: string;
      email: string;
    };
  };
}

export interface MoovBankAccount {
  bankAccountID: string;
  fingerprint: string;
  status: 'new' | 'verified' | 'verificationFailed' | 'pending' | 'errored';
  holderName: string;
  holderType: 'individual' | 'business';
  bankName: string;
  bankAccountType: 'checking' | 'savings';
  routingNumber: string;
  lastFourAccountNumber: string;
  paymentMethods?: MoovPaymentMethod[];
}

export interface MoovCard {
  cardID: string;
  fingerprint: string;
  brand: 'visa' | 'mastercard' | 'discover' | 'amex';
  cardType: 'debit' | 'credit' | 'prepaid';
  lastFourCardNumber: string;
  bin: string;
  expiration: { month: string; year: string };
  holderName: string;
  cardVerification?: {
    cvv: 'match' | 'noMatch' | 'notChecked';
    addressLine1: 'match' | 'noMatch' | 'notChecked';
    postalCode: 'match' | 'noMatch' | 'notChecked';
  };
  paymentMethods?: MoovPaymentMethod[];
}

export interface MoovPaymentMethod {
  paymentMethodID: string;
  paymentMethodType:
    | 'ach-debit-fund'
    | 'ach-debit-collect'
    | 'ach-credit-standard'
    | 'ach-credit-same-day'
    | 'rtp-credit'
    | 'card-payment'
    | 'push-to-card';
}

export interface MoovTransfer {
  transferID: string;
  createdOn: string;
  completedOn?: string;
  status: 'created' | 'pending' | 'completed' | 'failed' | 'reversed';
  failureReason?: string;
  amount: {
    currency: string;
    value: number; // In cents
  };
  description: string;
  metadata?: Record<string, string>;
  source: {
    accountID: string;
    paymentMethodID: string;
    paymentMethodType: string;
  };
  destination: {
    accountID: string;
    paymentMethodID: string;
    paymentMethodType: string;
  };
}

// ============================================================================
// Webhook Types
// ============================================================================

export interface MoovWebhookEvent {
  eventID: string;
  type: string;
  data: Record<string, unknown>;
  createdOn: string;
}

export type MoovEventType =
  | 'transfer.created'
  | 'transfer.pending'
  | 'transfer.completed'
  | 'transfer.failed'
  | 'transfer.reversed'
  | 'bank-account.created'
  | 'bank-account.updated'
  | 'card.created'
  | 'card.updated'
  | 'payment-method.enabled'
  | 'payment-method.disabled';

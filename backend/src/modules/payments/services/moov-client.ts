import { env } from '../../../config/env.js';
import { AppError } from '../../../common/errors/app-error.js';
import type {
  MoovAccount,
  MoovBankAccount,
  MoovCard,
  MoovTransfer,
  MoovPaymentMethod,
} from '../types.js';

/**
 * Moov API Client Wrapper
 *
 * NOTE: This is a simplified wrapper. The actual @moovio/sdk has a different API.
 * This stub allows the architecture to be tested; actual Moov integration
 * should be implemented when ready.
 */
export class MoovClient {
  private accountId: string;
  private baseUrl: string;

  constructor() {
    this.accountId = env.MOOV_ACCOUNT_ID;
    this.baseUrl = env.MOOV_ENVIRONMENT === 'production'
      ? 'https://api.moov.io'
      : 'https://api.sandbox.moov.io';
  }

  // ============================================================================
  // Accounts
  // ============================================================================

  async createAccount(params: {
    type: 'individual' | 'business';
    profile: Record<string, unknown>;
    metadata?: Record<string, string>;
  }): Promise<MoovAccount> {
    // TODO: Implement actual Moov API call
    // For now, return a mock response
    const mockId = `moov-acct-${Date.now()}`;
    return {
      accountID: mockId,
      accountType: params.type,
      displayName: params.type === 'individual'
        ? 'Individual Account'
        : 'Business Account',
      profile: params.profile as any,
    };
  }

  async getAccount(accountId: string): Promise<MoovAccount> {
    // TODO: Implement actual Moov API call
    return {
      accountID: accountId,
      accountType: 'individual',
      displayName: 'Account',
    };
  }

  // ============================================================================
  // Bank Accounts
  // ============================================================================

  async linkBankAccount(
    accountId: string,
    params: {
      holderName: string;
      holderType: 'individual' | 'business';
      routingNumber: string;
      accountNumber: string;
      accountType: 'checking' | 'savings';
    }
  ): Promise<MoovBankAccount> {
    // TODO: Implement actual Moov API call
    const mockId = `moov-bank-${Date.now()}`;
    return {
      bankAccountID: mockId,
      fingerprint: `fp-${mockId}`,
      status: 'new',
      holderName: params.holderName,
      holderType: params.holderType,
      bankName: 'Mock Bank',
      bankAccountType: params.accountType,
      routingNumber: params.routingNumber,
      lastFourAccountNumber: params.accountNumber.slice(-4),
      paymentMethods: [
        { paymentMethodID: `pm-ach-${mockId}`, paymentMethodType: 'ach-debit-fund' },
        { paymentMethodID: `pm-ach-credit-${mockId}`, paymentMethodType: 'ach-credit-standard' },
      ],
    };
  }

  async linkBankAccountWithPlaid(
    accountId: string,
    plaidToken: string
  ): Promise<MoovBankAccount> {
    // TODO: Implement actual Moov API call
    const mockId = `moov-plaid-${Date.now()}`;
    return {
      bankAccountID: mockId,
      fingerprint: `fp-${mockId}`,
      status: 'verified',
      holderName: 'Plaid User',
      holderType: 'individual',
      bankName: 'Plaid Bank',
      bankAccountType: 'checking',
      routingNumber: '******789',
      lastFourAccountNumber: '1234',
      paymentMethods: [
        { paymentMethodID: `pm-ach-${mockId}`, paymentMethodType: 'ach-debit-fund' },
        { paymentMethodID: `pm-rtp-${mockId}`, paymentMethodType: 'rtp-credit' },
      ],
    };
  }

  async getBankAccount(accountId: string, bankAccountId: string): Promise<MoovBankAccount> {
    // TODO: Implement actual Moov API call
    return {
      bankAccountID: bankAccountId,
      fingerprint: `fp-${bankAccountId}`,
      status: 'verified',
      holderName: 'Account Holder',
      holderType: 'individual',
      bankName: 'Mock Bank',
      bankAccountType: 'checking',
      routingNumber: '******789',
      lastFourAccountNumber: '1234',
      paymentMethods: [
        { paymentMethodID: `pm-${bankAccountId}`, paymentMethodType: 'ach-debit-fund' },
      ],
    };
  }

  async initiateMicroDeposits(accountId: string, bankAccountId: string): Promise<void> {
    // TODO: Implement actual Moov API call
    console.log(`Initiating micro-deposits for ${bankAccountId}`);
  }

  async verifyMicroDeposits(
    accountId: string,
    bankAccountId: string,
    amounts: [number, number]
  ): Promise<MoovBankAccount> {
    // TODO: Implement actual Moov API call
    return this.getBankAccount(accountId, bankAccountId);
  }

  // ============================================================================
  // Cards
  // ============================================================================

  async linkCard(
    accountId: string,
    params: {
      cardNumber: string;
      expMonth: string;
      expYear: string;
      cardCvv: string;
      holderName: string;
      billingAddress?: Record<string, string>;
    }
  ): Promise<MoovCard> {
    // TODO: Implement actual Moov API call
    const mockId = `moov-card-${Date.now()}`;
    return {
      cardID: mockId,
      fingerprint: `fp-${mockId}`,
      brand: 'visa',
      cardType: 'debit',
      lastFourCardNumber: params.cardNumber.slice(-4),
      bin: params.cardNumber.slice(0, 6),
      expiration: { month: params.expMonth, year: params.expYear },
      holderName: params.holderName,
      paymentMethods: [
        { paymentMethodID: `pm-card-${mockId}`, paymentMethodType: 'push-to-card' },
      ],
    };
  }

  async getCard(accountId: string, cardId: string): Promise<MoovCard> {
    // TODO: Implement actual Moov API call
    return {
      cardID: cardId,
      fingerprint: `fp-${cardId}`,
      brand: 'visa',
      cardType: 'debit',
      lastFourCardNumber: '1234',
      bin: '411111',
      expiration: { month: '12', year: '25' },
      holderName: 'Card Holder',
      paymentMethods: [
        { paymentMethodID: `pm-${cardId}`, paymentMethodType: 'push-to-card' },
      ],
    };
  }

  // ============================================================================
  // Payment Methods
  // ============================================================================

  async listPaymentMethods(accountId: string): Promise<MoovPaymentMethod[]> {
    // TODO: Implement actual Moov API call
    return [
      { paymentMethodID: `pm-ach-${accountId}`, paymentMethodType: 'ach-debit-fund' },
      { paymentMethodID: `pm-ach-credit-${accountId}`, paymentMethodType: 'ach-credit-standard' },
    ];
  }

  async getPaymentMethodsForInstrument(
    accountId: string,
    instrumentId: string,
    instrumentType: 'bank_account' | 'debit_card'
  ): Promise<MoovPaymentMethod[]> {
    if (instrumentType === 'bank_account') {
      const bankAccount = await this.getBankAccount(accountId, instrumentId);
      return bankAccount.paymentMethods || [];
    } else {
      const card = await this.getCard(accountId, instrumentId);
      return card.paymentMethods || [];
    }
  }

  // ============================================================================
  // Transfers
  // ============================================================================

  async createTransfer(params: {
    sourceAccountId: string;
    sourcePaymentMethodId: string;
    destinationAccountId: string;
    destinationPaymentMethodId: string;
    amountCents: number;
    description: string;
    metadata?: Record<string, string>;
  }): Promise<MoovTransfer> {
    // TODO: Implement actual Moov API call
    const transferId = `moov-xfer-${Date.now()}`;
    return {
      transferID: transferId,
      createdOn: new Date().toISOString(),
      status: 'pending',
      amount: {
        currency: 'USD',
        value: params.amountCents,
      },
      description: params.description,
      metadata: params.metadata,
      source: {
        accountID: params.sourceAccountId,
        paymentMethodID: params.sourcePaymentMethodId,
        paymentMethodType: 'ach-debit-fund',
      },
      destination: {
        accountID: params.destinationAccountId,
        paymentMethodID: params.destinationPaymentMethodId,
        paymentMethodType: 'ach-credit-standard',
      },
    };
  }

  async getTransfer(transferId: string): Promise<MoovTransfer> {
    // TODO: Implement actual Moov API call
    return {
      transferID: transferId,
      createdOn: new Date().toISOString(),
      status: 'completed',
      amount: {
        currency: 'USD',
        value: 0,
      },
      description: 'Transfer',
      source: {
        accountID: 'source',
        paymentMethodID: 'pm-source',
        paymentMethodType: 'ach-debit-fund',
      },
      destination: {
        accountID: 'dest',
        paymentMethodID: 'pm-dest',
        paymentMethodType: 'ach-credit-standard',
      },
    };
  }

  async listTransfers(
    accountId: string,
    options?: {
      status?: string;
      startDateTime?: string;
      endDateTime?: string;
      count?: number;
    }
  ): Promise<MoovTransfer[]> {
    // TODO: Implement actual Moov API call
    return [];
  }

  async cancelTransfer(transferId: string): Promise<void> {
    // TODO: Implement actual Moov API call
    console.log(`Cancelling transfer ${transferId}`);
  }

  async refundTransfer(transferId: string, amountCents?: number): Promise<MoovTransfer> {
    // TODO: Implement actual Moov API call
    return this.getTransfer(transferId);
  }

  // ============================================================================
  // Error Mapping
  // ============================================================================

  private mapError(error: any, context: string): AppError {
    const message = error?.message || error?.toString() || 'Unknown error';
    const statusCode = error?.statusCode || error?.status || 500;

    if (statusCode === 400) {
      return AppError.invalidRequest(`${context}: ${message}`, { moovError: error });
    }

    if (statusCode === 401 || statusCode === 403) {
      return AppError.providerError(`Moov authentication failed: ${message}`, { moovError: error });
    }

    if (statusCode === 404) {
      return AppError.notFound(context.replace('Failed to ', ''));
    }

    if (statusCode === 409) {
      return AppError.invalidState(`${context}: ${message}`);
    }

    return AppError.providerError(`${context}: ${message}`, { moovError: error });
  }
}

// Singleton instance
let moovClientInstance: MoovClient | null = null;

export function getMoovClient(): MoovClient {
  if (!moovClientInstance) {
    moovClientInstance = new MoovClient();
  }
  return moovClientInstance;
}

import { prisma } from '../../config/database.js';
import { getMoovClient } from '../payments/services/moov-client.js';
import { LedgerService } from '../ledger/service.js';
import { nanoid } from 'nanoid';
import {
  DEFAULT_RECONCILIATION_CONFIG,
  type ReconciliationType,
  type ExceptionSeverity,
  type ReconciliationException,
  type ReconciliationRun,
  type ReconciliationSummary,
  type ReconciliationConfig,
  type RunReconciliationInput,
  type ReconciliationResult,
  type ProviderTransferRecord,
} from './types.js';

/**
 * Daily Reconciliation Service
 *
 * Compares internal records with payment provider (Moov) to identify:
 * - Status mismatches (pending vs completed)
 * - Missing transfers (in provider but not locally)
 * - Orphaned transfers (locally but not in provider)
 * - Amount discrepancies
 * - Ledger imbalances
 * - Prefund balance mismatches
 */
export class ReconciliationService {
  private moov = getMoovClient();
  private ledger = new LedgerService(prisma);
  private config: ReconciliationConfig;

  constructor(config: Partial<ReconciliationConfig> = {}) {
    this.config = { ...DEFAULT_RECONCILIATION_CONFIG, ...config };
  }

  /**
   * Run full reconciliation for a tenant
   */
  async runReconciliation(input: RunReconciliationInput): Promise<ReconciliationResult> {
    const { tenantId, dryRun = false } = input;

    // Default period: last N days
    const periodEnd = input.periodEnd || new Date();
    const periodStart = input.periodStart || new Date(
      periodEnd.getTime() - this.config.defaultLookbackDays * 24 * 60 * 60 * 1000
    );

    // Create reconciliation run record
    const run: ReconciliationRun = {
      id: nanoid(),
      tenantId,
      runDate: new Date(),
      startedAt: new Date(),
      status: 'running',
      periodStart,
      periodEnd,
      totalRecordsChecked: 0,
      exceptionsFound: 0,
      autoResolved: 0,
      summary: this.createEmptySummary(),
    };

    const exceptions: ReconciliationException[] = [];
    const autoResolved: ReconciliationException[] = [];

    try {
      // 1. Reconcile disbursements
      const disbursementExceptions = await this.reconcileDisbursements(
        tenantId,
        periodStart,
        periodEnd,
        run.summary
      );
      exceptions.push(...disbursementExceptions);

      // 2. Reconcile repayments
      const repaymentExceptions = await this.reconcileRepayments(
        tenantId,
        periodStart,
        periodEnd,
        run.summary
      );
      exceptions.push(...repaymentExceptions);

      // 3. Check ledger balance
      const ledgerExceptions = await this.reconcileLedger(tenantId, run.summary);
      exceptions.push(...ledgerExceptions);

      // 4. Check prefund balances
      const prefundExceptions = await this.reconcilePrefundBalances(
        tenantId,
        run.summary
      );
      exceptions.push(...prefundExceptions);

      // Calculate totals
      run.totalRecordsChecked =
        run.summary.disbursements.checked +
        run.summary.repayments.checked +
        run.summary.prefund.accountsChecked +
        1; // +1 for ledger check

      run.exceptionsFound = exceptions.length;

      // Auto-resolve eligible exceptions
      if (!dryRun && this.config.autoResolveStatusUpdates) {
        for (const exception of exceptions) {
          if (this.canAutoResolve(exception)) {
            await this.autoResolveException(exception);
            autoResolved.push(exception);
          }
        }
      }

      run.autoResolved = autoResolved.length;
      run.status = 'completed';
      run.completedAt = new Date();

      // Persist exceptions (if not dry run)
      if (!dryRun) {
        await this.persistExceptions(exceptions.filter(e => e.status === 'open'));
        await this.persistReconciliationRun(run);
      }

      return { run, exceptions, autoResolved };
    } catch (error) {
      run.status = 'failed';
      run.errorMessage = (error as Error).message;
      run.completedAt = new Date();

      if (!dryRun) {
        await this.persistReconciliationRun(run);
      }

      throw error;
    }
  }

  /**
   * Reconcile disbursements against provider
   */
  private async reconcileDisbursements(
    tenantId: string,
    periodStart: Date,
    periodEnd: Date,
    summary: ReconciliationSummary
  ): Promise<ReconciliationException[]> {
    const exceptions: ReconciliationException[] = [];

    // Get local disbursements in period
    const disbursements = await prisma.disbursement.findMany({
      where: {
        contract: { tenantId },
        initiatedAt: {
          gte: periodStart,
          lte: periodEnd,
        },
        providerRef: { not: null },
      },
      include: {
        contract: true,
      },
    });

    summary.disbursements.checked = disbursements.length;

    // Get provider transfers
    const providerTransfers = await this.getProviderTransfers(periodStart, periodEnd);
    const providerTransferMap = new Map(
      providerTransfers.map(t => [t.transferId, t])
    );

    // Check each local disbursement against provider
    for (const disbursement of disbursements) {
      const providerRef = disbursement.providerRef!;
      const providerRecord = providerTransferMap.get(providerRef);

      if (!providerRecord) {
        // Orphaned - exists locally but not in provider
        // This could be normal for very recent transfers
        const hoursSinceInitiated =
          (Date.now() - disbursement.initiatedAt.getTime()) / (1000 * 60 * 60);

        if (hoursSinceInitiated > 24) {
          summary.disbursements.orphaned++;
          exceptions.push(
            this.createException({
              tenantId,
              type: 'transfer_orphaned',
              severity: this.calculateSeverity(disbursement.amountCents),
              localRecordType: 'disbursement',
              localRecordId: disbursement.id,
              providerRecordId: providerRef,
              localValue: JSON.stringify({
                status: disbursement.status,
                amountCents: disbursement.amountCents,
                initiatedAt: disbursement.initiatedAt,
              }),
              description: `Disbursement ${disbursement.id} not found in provider after 24 hours`,
            })
          );
        }
        continue;
      }

      // Check status match
      const localStatus = this.normalizeStatus(disbursement.status);
      const providerStatus = this.normalizeStatus(providerRecord.status);

      if (localStatus !== providerStatus) {
        summary.disbursements.statusMismatch++;
        exceptions.push(
          this.createException({
            tenantId,
            type: 'transfer_status',
            severity: this.getStatusMismatchSeverity(localStatus, providerStatus),
            localRecordType: 'disbursement',
            localRecordId: disbursement.id,
            providerRecordId: providerRef,
            localValue: JSON.stringify({ status: disbursement.status }),
            providerValue: JSON.stringify({ status: providerRecord.status }),
            description: `Status mismatch: local=${disbursement.status}, provider=${providerRecord.status}`,
          })
        );
      } else if (disbursement.amountCents !== providerRecord.amountCents) {
        // Check amount match
        summary.disbursements.amountMismatch++;
        const discrepancy = Math.abs(disbursement.amountCents - providerRecord.amountCents);
        exceptions.push(
          this.createException({
            tenantId,
            type: 'amount_mismatch',
            severity: this.calculateSeverity(discrepancy),
            localRecordType: 'disbursement',
            localRecordId: disbursement.id,
            providerRecordId: providerRef,
            localValue: JSON.stringify({ amountCents: disbursement.amountCents }),
            providerValue: JSON.stringify({ amountCents: providerRecord.amountCents }),
            discrepancyAmountCents: discrepancy,
            description: `Amount mismatch: local=${disbursement.amountCents}, provider=${providerRecord.amountCents}`,
          })
        );
      } else {
        summary.disbursements.matched++;
      }

      // Remove from map to track what's been matched
      providerTransferMap.delete(providerRef);
    }

    // Any remaining in provider map are missing locally
    // (Filter to only disbursement-type transfers based on metadata)
    for (const [transferId, providerRecord] of providerTransferMap) {
      if (providerRecord.metadata?.type === 'disbursement') {
        summary.disbursements.missing++;
        exceptions.push(
          this.createException({
            tenantId,
            type: 'transfer_missing',
            severity: this.calculateSeverity(providerRecord.amountCents),
            providerRecordId: transferId,
            providerValue: JSON.stringify(providerRecord),
            description: `Provider transfer ${transferId} not found in local disbursements`,
          })
        );
      }
    }

    return exceptions;
  }

  /**
   * Reconcile repayments against provider
   */
  private async reconcileRepayments(
    tenantId: string,
    periodStart: Date,
    periodEnd: Date,
    summary: ReconciliationSummary
  ): Promise<ReconciliationException[]> {
    const exceptions: ReconciliationException[] = [];

    // Get local repayments in period
    const repayments = await prisma.repayment.findMany({
      where: {
        contract: { tenantId },
        initiatedAt: {
          gte: periodStart,
          lte: periodEnd,
        },
        providerRef: { not: null },
      },
      include: {
        contract: true,
      },
    });

    summary.repayments.checked = repayments.length;

    // Get provider transfers (reuse from disbursements if available)
    const providerTransfers = await this.getProviderTransfers(periodStart, periodEnd);
    const providerTransferMap = new Map(
      providerTransfers.map(t => [t.transferId, t])
    );

    // Check each local repayment against provider
    for (const repayment of repayments) {
      const providerRef = repayment.providerRef!;
      const providerRecord = providerTransferMap.get(providerRef);

      if (!providerRecord) {
        const hoursSinceInitiated = repayment.initiatedAt
          ? (Date.now() - repayment.initiatedAt.getTime()) / (1000 * 60 * 60)
          : 0;

        if (hoursSinceInitiated > 24) {
          summary.repayments.orphaned++;
          exceptions.push(
            this.createException({
              tenantId,
              type: 'transfer_orphaned',
              severity: this.calculateSeverity(repayment.amountCents),
              localRecordType: 'repayment',
              localRecordId: repayment.id,
              providerRecordId: providerRef,
              localValue: JSON.stringify({
                status: repayment.status,
                amountCents: repayment.amountCents,
                initiatedAt: repayment.initiatedAt,
              }),
              description: `Repayment ${repayment.id} not found in provider after 24 hours`,
            })
          );
        }
        continue;
      }

      // Check status match
      const localStatus = this.normalizeStatus(repayment.status);
      const providerStatus = this.normalizeStatus(providerRecord.status);

      if (localStatus !== providerStatus) {
        summary.repayments.statusMismatch++;
        exceptions.push(
          this.createException({
            tenantId,
            type: 'transfer_status',
            severity: this.getStatusMismatchSeverity(localStatus, providerStatus),
            localRecordType: 'repayment',
            localRecordId: repayment.id,
            providerRecordId: providerRef,
            localValue: JSON.stringify({ status: repayment.status }),
            providerValue: JSON.stringify({ status: providerRecord.status }),
            description: `Status mismatch: local=${repayment.status}, provider=${providerRecord.status}`,
          })
        );
      } else if (repayment.amountCents !== providerRecord.amountCents) {
        summary.repayments.amountMismatch++;
        const discrepancy = Math.abs(repayment.amountCents - providerRecord.amountCents);
        exceptions.push(
          this.createException({
            tenantId,
            type: 'amount_mismatch',
            severity: this.calculateSeverity(discrepancy),
            localRecordType: 'repayment',
            localRecordId: repayment.id,
            providerRecordId: providerRef,
            localValue: JSON.stringify({ amountCents: repayment.amountCents }),
            providerValue: JSON.stringify({ amountCents: providerRecord.amountCents }),
            discrepancyAmountCents: discrepancy,
            description: `Amount mismatch: local=${repayment.amountCents}, provider=${providerRecord.amountCents}`,
          })
        );
      } else {
        summary.repayments.matched++;
      }
    }

    return exceptions;
  }

  /**
   * Check ledger balance
   */
  private async reconcileLedger(
    tenantId: string,
    summary: ReconciliationSummary
  ): Promise<ReconciliationException[]> {
    const exceptions: ReconciliationException[] = [];

    const trialBalance = await this.ledger.getTrialBalance();

    summary.ledger.isBalanced = trialBalance.isBalanced;
    summary.ledger.totalDebits = trialBalance.totalDebits;
    summary.ledger.totalCredits = trialBalance.totalCredits;
    summary.ledger.imbalanceAmount = Math.abs(
      trialBalance.totalDebits - trialBalance.totalCredits
    );

    if (!trialBalance.isBalanced) {
      exceptions.push(
        this.createException({
          tenantId,
          type: 'ledger_imbalance',
          severity: 'critical',
          localRecordType: 'ledger',
          discrepancyAmountCents: summary.ledger.imbalanceAmount,
          localValue: JSON.stringify({
            totalDebits: trialBalance.totalDebits,
            totalCredits: trialBalance.totalCredits,
          }),
          description: `Ledger imbalance: debits=${trialBalance.totalDebits}, credits=${trialBalance.totalCredits}`,
        })
      );
    }

    return exceptions;
  }

  /**
   * Reconcile prefund balances
   */
  private async reconcilePrefundBalances(
    tenantId: string,
    summary: ReconciliationSummary
  ): Promise<ReconciliationException[]> {
    const exceptions: ReconciliationException[] = [];

    // Get all customers with prefund transactions
    const customersWithPrefund = await prisma.customer.findMany({
      where: {
        tenantId,
        prefundTransactions: {
          some: {},
        },
      },
      include: {
        prefundTransactions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    summary.prefund.accountsChecked = customersWithPrefund.length;

    for (const customer of customersWithPrefund) {
      const latestTx = customer.prefundTransactions[0];
      if (!latestTx) continue;

      const ledgerBalance = latestTx.availableAfterCents;

      // Calculate expected balance from all transactions
      const allTransactions = await prisma.prefundTransaction.findMany({
        where: { customerId: customer.id },
      });

      const calculatedBalance = allTransactions.reduce((sum, tx) => {
        if (tx.status !== 'COMPLETED') return sum;

        switch (tx.type) {
          case 'DEPOSIT':
            return sum + tx.amountCents;
          case 'WITHDRAWAL':
          case 'FEE':
            return sum - tx.amountCents;
          case 'DISBURSEMENT_HOLD':
            return sum - tx.amountCents;
          case 'DISBURSEMENT_RELEASE':
            return sum + tx.amountCents;
          default:
            return sum;
        }
      }, 0);

      if (ledgerBalance !== calculatedBalance) {
        summary.prefund.balanceMismatches++;
        const discrepancy = Math.abs(ledgerBalance - calculatedBalance);
        summary.prefund.totalDiscrepancyCents += discrepancy;

        exceptions.push(
          this.createException({
            tenantId,
            type: 'prefund_mismatch',
            severity: this.calculateSeverity(discrepancy),
            localRecordType: 'prefund',
            localRecordId: customer.id,
            discrepancyAmountCents: discrepancy,
            localValue: JSON.stringify({
              recordedBalance: ledgerBalance,
              calculatedBalance,
            }),
            description: `Prefund balance mismatch for customer ${customer.id}: recorded=${ledgerBalance}, calculated=${calculatedBalance}`,
          })
        );
      } else {
        summary.prefund.balanceMatches++;
      }
    }

    return exceptions;
  }

  /**
   * Get transfers from payment provider
   */
  private async getProviderTransfers(
    startDate: Date,
    endDate: Date
  ): Promise<ProviderTransferRecord[]> {
    try {
      const transfers = await this.moov.listTransfers('', {
        startDateTime: startDate.toISOString(),
        endDateTime: endDate.toISOString(),
      });

      return transfers.map(t => ({
        transferId: t.transferID,
        status: t.status,
        amountCents: t.amount.value,
        createdAt: new Date(t.createdOn),
        completedAt: t.completedOn ? new Date(t.completedOn) : undefined,
        metadata: t.metadata,
      }));
    } catch (error) {
      console.error('Failed to fetch provider transfers:', error);
      return [];
    }
  }

  /**
   * Normalize status for comparison
   */
  private normalizeStatus(status: string): string {
    const statusMap: Record<string, string> = {
      // Local statuses
      'PENDING': 'pending',
      'PROCESSING': 'pending',
      'COMPLETED': 'completed',
      'FAILED': 'failed',
      'RETURNED': 'returned',
      'CANCELLED': 'cancelled',
      // Provider statuses
      'created': 'pending',
      'pending': 'pending',
      'completed': 'completed',
      'failed': 'failed',
      'reversed': 'returned',
    };
    return statusMap[status] || status.toLowerCase();
  }

  /**
   * Calculate severity based on amount
   */
  private calculateSeverity(amountCents: number): ExceptionSeverity {
    if (amountCents >= this.config.criticalSeverityThresholdCents) {
      return 'critical';
    } else if (amountCents >= this.config.highSeverityThresholdCents) {
      return 'high';
    } else if (amountCents >= 1000) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Get severity for status mismatch
   */
  private getStatusMismatchSeverity(
    localStatus: string,
    providerStatus: string
  ): ExceptionSeverity {
    // Critical: we think completed but provider says failed
    if (localStatus === 'completed' && providerStatus === 'failed') {
      return 'critical';
    }
    // High: we think pending but provider completed (need to update)
    if (localStatus === 'pending' && providerStatus === 'completed') {
      return 'high';
    }
    // Medium: other mismatches
    return 'medium';
  }

  /**
   * Check if exception can be auto-resolved
   */
  private canAutoResolve(exception: ReconciliationException): boolean {
    // Only auto-resolve status mismatches where provider is ahead
    if (exception.type !== 'transfer_status') {
      return false;
    }

    // Check if discrepancy is within threshold
    if (
      exception.discrepancyAmountCents &&
      exception.discrepancyAmountCents > this.config.autoResolveThresholdCents
    ) {
      return false;
    }

    // Only auto-resolve when provider shows completed and we show pending
    try {
      const local = JSON.parse(exception.localValue || '{}');
      const provider = JSON.parse(exception.providerValue || '{}');

      const localStatus = this.normalizeStatus(local.status || '');
      const providerStatus = this.normalizeStatus(provider.status || '');

      return localStatus === 'pending' && providerStatus === 'completed';
    } catch {
      return false;
    }
  }

  /**
   * Auto-resolve an exception by updating local status
   */
  private async autoResolveException(
    exception: ReconciliationException
  ): Promise<void> {
    if (!exception.localRecordId || !exception.localRecordType) {
      return;
    }

    try {
      const provider = JSON.parse(exception.providerValue || '{}');

      if (exception.localRecordType === 'disbursement') {
        await prisma.disbursement.update({
          where: { id: exception.localRecordId },
          data: {
            status: 'COMPLETED',
            availabilityState: 'AVAILABLE',
            completedAt: new Date(),
          },
        });
      } else if (exception.localRecordType === 'repayment') {
        await prisma.repayment.update({
          where: { id: exception.localRecordId },
          data: {
            status: 'COMPLETED',
            availabilityState: 'AVAILABLE',
            completedAt: new Date(),
          },
        });
      }

      exception.status = 'resolved';
      exception.resolvedAt = new Date();
      exception.resolutionType = 'auto_corrected';
      exception.resolutionNotes = 'Auto-resolved: updated status from provider';
    } catch (error) {
      console.error('Failed to auto-resolve exception:', error);
    }
  }

  /**
   * Create an exception object
   */
  private createException(
    data: Partial<ReconciliationException> & {
      tenantId: string;
      type: ReconciliationType;
      severity: ExceptionSeverity;
      description: string;
    }
  ): ReconciliationException {
    return {
      id: nanoid(),
      status: 'open',
      reconciliationDate: new Date(),
      detectedAt: new Date(),
      ...data,
    };
  }

  /**
   * Create empty summary object
   */
  private createEmptySummary(): ReconciliationSummary {
    return {
      disbursements: {
        checked: 0,
        matched: 0,
        statusMismatch: 0,
        amountMismatch: 0,
        missing: 0,
        orphaned: 0,
      },
      repayments: {
        checked: 0,
        matched: 0,
        statusMismatch: 0,
        amountMismatch: 0,
        missing: 0,
        orphaned: 0,
      },
      ledger: {
        isBalanced: true,
        totalDebits: 0,
        totalCredits: 0,
        imbalanceAmount: 0,
      },
      prefund: {
        accountsChecked: 0,
        balanceMatches: 0,
        balanceMismatches: 0,
        totalDiscrepancyCents: 0,
      },
    };
  }

  /**
   * Persist exceptions to database
   */
  private async persistExceptions(
    exceptions: ReconciliationException[]
  ): Promise<void> {
    // In a real implementation, this would save to a ReconciliationException table
    // For now, we'll log them
    for (const exception of exceptions) {
      console.log('Reconciliation exception:', {
        id: exception.id,
        type: exception.type,
        severity: exception.severity,
        description: exception.description,
      });
    }
  }

  /**
   * Persist reconciliation run to database
   */
  private async persistReconciliationRun(run: ReconciliationRun): Promise<void> {
    // In a real implementation, this would save to a ReconciliationRun table
    console.log('Reconciliation run completed:', {
      id: run.id,
      status: run.status,
      exceptionsFound: run.exceptionsFound,
      autoResolved: run.autoResolved,
    });
  }

  /**
   * Get exception by ID
   */
  async getException(exceptionId: string): Promise<ReconciliationException | null> {
    // Would query from database
    return null;
  }

  /**
   * Update exception status
   */
  async updateExceptionStatus(
    exceptionId: string,
    status: 'investigating' | 'resolved' | 'ignored',
    userId: string,
    notes?: string
  ): Promise<ReconciliationException | null> {
    // Would update in database
    return null;
  }

  /**
   * Get open exceptions for a tenant
   */
  async getOpenExceptions(
    tenantId: string,
    options?: {
      type?: ReconciliationType;
      severity?: ExceptionSeverity;
      limit?: number;
      offset?: number;
    }
  ): Promise<ReconciliationException[]> {
    // Would query from database
    return [];
  }

  /**
   * Get reconciliation history
   */
  async getReconciliationHistory(
    tenantId: string,
    options?: {
      limit?: number;
      offset?: number;
    }
  ): Promise<ReconciliationRun[]> {
    // Would query from database
    return [];
  }
}

// Singleton instance
let reconciliationServiceInstance: ReconciliationService | null = null;

export function getReconciliationService(): ReconciliationService {
  if (!reconciliationServiceInstance) {
    reconciliationServiceInstance = new ReconciliationService();
  }
  return reconciliationServiceInstance;
}

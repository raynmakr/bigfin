// ============================================================================
// Reconciliation Types
// ============================================================================

export type ReconciliationType =
  | 'transfer_status'      // Transfer status mismatch
  | 'transfer_missing'     // Transfer exists in provider but not locally
  | 'transfer_orphaned'    // Transfer exists locally but not in provider
  | 'amount_mismatch'      // Amount differs between local and provider
  | 'ledger_imbalance'     // Ledger is not balanced
  | 'prefund_mismatch';    // Prefund balance doesn't match ledger

export type ExceptionSeverity = 'low' | 'medium' | 'high' | 'critical';

export type ExceptionStatus = 'open' | 'investigating' | 'resolved' | 'ignored';

export type ResolutionType =
  | 'auto_corrected'       // System automatically fixed
  | 'manual_adjustment'    // Operator made adjustment
  | 'provider_confirmed'   // Provider confirmed their data is correct
  | 'local_confirmed'      // Our data confirmed correct, provider updated
  | 'written_off'          // Difference written off
  | 'duplicate'            // Was a duplicate entry
  | 'false_positive';      // Not actually an exception

export interface ReconciliationException {
  id: string;
  tenantId: string;
  type: ReconciliationType;
  severity: ExceptionSeverity;
  status: ExceptionStatus;

  // Reference to affected records
  localRecordType?: 'disbursement' | 'repayment' | 'prefund' | 'ledger';
  localRecordId?: string;
  providerRecordId?: string;

  // Discrepancy details
  localValue?: string;       // JSON of local data
  providerValue?: string;    // JSON of provider data
  discrepancyAmountCents?: number;

  // Metadata
  description: string;
  reconciliationDate: Date;
  detectedAt: Date;

  // Resolution
  resolvedAt?: Date;
  resolvedBy?: string;
  resolutionType?: ResolutionType;
  resolutionNotes?: string;
}

export interface ReconciliationRun {
  id: string;
  tenantId: string;
  runDate: Date;
  startedAt: Date;
  completedAt?: Date;
  status: 'running' | 'completed' | 'failed';

  // Scope
  periodStart: Date;
  periodEnd: Date;

  // Results
  totalRecordsChecked: number;
  exceptionsFound: number;
  autoResolved: number;

  // Summary by type
  summary: ReconciliationSummary;

  // Error if failed
  errorMessage?: string;
}

export interface ReconciliationSummary {
  disbursements: {
    checked: number;
    matched: number;
    statusMismatch: number;
    amountMismatch: number;
    missing: number;
    orphaned: number;
  };
  repayments: {
    checked: number;
    matched: number;
    statusMismatch: number;
    amountMismatch: number;
    missing: number;
    orphaned: number;
  };
  ledger: {
    isBalanced: boolean;
    totalDebits: number;
    totalCredits: number;
    imbalanceAmount: number;
  };
  prefund: {
    accountsChecked: number;
    balanceMatches: number;
    balanceMismatches: number;
    totalDiscrepancyCents: number;
  };
}

export interface ReconciliationConfig {
  // How many days back to reconcile if not specified
  defaultLookbackDays: number;

  // Auto-resolve settings
  autoResolveStatusUpdates: boolean;
  autoResolveThresholdCents: number;  // Max amount to auto-resolve

  // Severity thresholds
  highSeverityThresholdCents: number;
  criticalSeverityThresholdCents: number;

  // Notification settings
  notifyOnCritical: boolean;
  notifyOnHighCount: number;  // Notify if more than N high severity
}

// Default configuration
export const DEFAULT_RECONCILIATION_CONFIG: ReconciliationConfig = {
  defaultLookbackDays: 7,
  autoResolveStatusUpdates: true,
  autoResolveThresholdCents: 100,  // $1.00
  highSeverityThresholdCents: 10000,  // $100
  criticalSeverityThresholdCents: 100000,  // $1000
  notifyOnCritical: true,
  notifyOnHighCount: 10,
};

// ============================================================================
// Service Input/Output Types
// ============================================================================

export interface RunReconciliationInput {
  tenantId: string;
  periodStart?: Date;
  periodEnd?: Date;
  types?: ReconciliationType[];  // If not specified, run all
  dryRun?: boolean;  // If true, don't create exceptions, just report
}

export interface ReconciliationResult {
  run: ReconciliationRun;
  exceptions: ReconciliationException[];
  autoResolved: ReconciliationException[];
}

export interface TransferReconciliationRecord {
  localId: string;
  providerRef: string;
  type: 'disbursement' | 'repayment';
  localStatus: string;
  localAmountCents: number;
  initiatedAt: Date;
  completedAt?: Date;
}

export interface ProviderTransferRecord {
  transferId: string;
  status: string;
  amountCents: number;
  createdAt: Date;
  completedAt?: Date;
  metadata?: Record<string, string>;
}

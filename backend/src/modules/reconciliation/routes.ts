import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../common/middleware/auth.js';
import { AppError } from '../../common/errors/app-error.js';
import { getReconciliationService } from './service.js';
import type { ReconciliationType, ExceptionSeverity } from './types.js';

const runReconciliationSchema = z.object({
  period_start: z.string().datetime().optional(),
  period_end: z.string().datetime().optional(),
  types: z.array(z.enum([
    'transfer_status',
    'transfer_missing',
    'transfer_orphaned',
    'amount_mismatch',
    'ledger_imbalance',
    'prefund_mismatch',
  ])).optional(),
  dry_run: z.boolean().optional(),
});

const updateExceptionSchema = z.object({
  status: z.enum(['investigating', 'resolved', 'ignored']),
  resolution_type: z.enum([
    'auto_corrected',
    'manual_adjustment',
    'provider_confirmed',
    'local_confirmed',
    'written_off',
    'duplicate',
    'false_positive',
  ]).optional(),
  notes: z.string().optional(),
});

export async function reconciliationRoutes(app: FastifyInstance) {
  const reconciliationService = getReconciliationService();

  // ============================================================================
  // Run Reconciliation
  // ============================================================================

  // POST /reconciliation/run - Run reconciliation job
  app.post('/run', {
    onRequest: [authenticate],
    schema: {
      description: 'Run daily reconciliation job',
      tags: ['Reconciliation'],
    },
  }, async (request, reply) => {
    // Only admins can run reconciliation
    if (request.user.role !== 'ADMIN') {
      throw AppError.forbidden('Only admins can run reconciliation');
    }

    const body = runReconciliationSchema.parse(request.body || {});
    const tenantId = request.user.tenantId;

    const result = await reconciliationService.runReconciliation({
      tenantId,
      periodStart: body.period_start ? new Date(body.period_start) : undefined,
      periodEnd: body.period_end ? new Date(body.period_end) : undefined,
      types: body.types as ReconciliationType[],
      dryRun: body.dry_run,
    });

    reply.status(200);
    return {
      run: {
        id: result.run.id,
        status: result.run.status,
        run_date: result.run.runDate.toISOString(),
        period_start: result.run.periodStart.toISOString(),
        period_end: result.run.periodEnd.toISOString(),
        started_at: result.run.startedAt.toISOString(),
        completed_at: result.run.completedAt?.toISOString(),
        total_records_checked: result.run.totalRecordsChecked,
        exceptions_found: result.run.exceptionsFound,
        auto_resolved: result.run.autoResolved,
        summary: {
          disbursements: result.run.summary.disbursements,
          repayments: result.run.summary.repayments,
          ledger: result.run.summary.ledger,
          prefund: result.run.summary.prefund,
        },
      },
      exceptions: result.exceptions.map(e => ({
        id: e.id,
        type: e.type,
        severity: e.severity,
        status: e.status,
        local_record_type: e.localRecordType,
        local_record_id: e.localRecordId,
        provider_record_id: e.providerRecordId,
        discrepancy_amount_cents: e.discrepancyAmountCents,
        description: e.description,
        detected_at: e.detectedAt.toISOString(),
      })),
      auto_resolved_count: result.autoResolved.length,
    };
  });

  // ============================================================================
  // Exception Management
  // ============================================================================

  // GET /reconciliation/exceptions - List open exceptions
  app.get('/exceptions', {
    onRequest: [authenticate],
    schema: {
      description: 'List reconciliation exceptions',
      tags: ['Reconciliation'],
    },
  }, async (request) => {
    const query = request.query as {
      type?: string;
      severity?: string;
      status?: string;
      limit?: string;
      offset?: string;
    };

    const tenantId = request.user.tenantId;

    const exceptions = await reconciliationService.getOpenExceptions(tenantId, {
      type: query.type as ReconciliationType,
      severity: query.severity as ExceptionSeverity,
      limit: query.limit ? parseInt(query.limit) : 50,
      offset: query.offset ? parseInt(query.offset) : 0,
    });

    return {
      exceptions: exceptions.map(e => ({
        id: e.id,
        type: e.type,
        severity: e.severity,
        status: e.status,
        local_record_type: e.localRecordType,
        local_record_id: e.localRecordId,
        provider_record_id: e.providerRecordId,
        discrepancy_amount_cents: e.discrepancyAmountCents,
        description: e.description,
        detected_at: e.detectedAt.toISOString(),
        resolved_at: e.resolvedAt?.toISOString(),
        resolution_type: e.resolutionType,
      })),
      total: exceptions.length,
    };
  });

  // GET /reconciliation/exceptions/:exception_id - Get exception details
  app.get('/exceptions/:exception_id', {
    onRequest: [authenticate],
    schema: {
      description: 'Get reconciliation exception details',
      tags: ['Reconciliation'],
    },
  }, async (request) => {
    const { exception_id } = request.params as { exception_id: string };

    const exception = await reconciliationService.getException(exception_id);

    if (!exception) {
      throw AppError.notFound('Exception');
    }

    return {
      id: exception.id,
      type: exception.type,
      severity: exception.severity,
      status: exception.status,
      local_record_type: exception.localRecordType,
      local_record_id: exception.localRecordId,
      provider_record_id: exception.providerRecordId,
      local_value: exception.localValue ? JSON.parse(exception.localValue) : null,
      provider_value: exception.providerValue ? JSON.parse(exception.providerValue) : null,
      discrepancy_amount_cents: exception.discrepancyAmountCents,
      description: exception.description,
      reconciliation_date: exception.reconciliationDate.toISOString(),
      detected_at: exception.detectedAt.toISOString(),
      resolved_at: exception.resolvedAt?.toISOString(),
      resolved_by: exception.resolvedBy,
      resolution_type: exception.resolutionType,
      resolution_notes: exception.resolutionNotes,
    };
  });

  // PATCH /reconciliation/exceptions/:exception_id - Update exception status
  app.patch('/exceptions/:exception_id', {
    onRequest: [authenticate],
    schema: {
      description: 'Update exception status',
      tags: ['Reconciliation'],
    },
  }, async (request) => {
    const { exception_id } = request.params as { exception_id: string };
    const body = updateExceptionSchema.parse(request.body);
    const userId = request.user.sub;

    const exception = await reconciliationService.updateExceptionStatus(
      exception_id,
      body.status,
      userId,
      body.notes
    );

    if (!exception) {
      throw AppError.notFound('Exception');
    }

    return {
      id: exception.id,
      status: exception.status,
      resolved_at: exception.resolvedAt?.toISOString(),
      resolved_by: exception.resolvedBy,
      resolution_type: exception.resolutionType,
      resolution_notes: exception.resolutionNotes,
    };
  });

  // ============================================================================
  // Reconciliation History
  // ============================================================================

  // GET /reconciliation/history - Get reconciliation run history
  app.get('/history', {
    onRequest: [authenticate],
    schema: {
      description: 'Get reconciliation run history',
      tags: ['Reconciliation'],
    },
  }, async (request) => {
    const query = request.query as {
      limit?: string;
      offset?: string;
    };

    const tenantId = request.user.tenantId;

    const runs = await reconciliationService.getReconciliationHistory(tenantId, {
      limit: query.limit ? parseInt(query.limit) : 20,
      offset: query.offset ? parseInt(query.offset) : 0,
    });

    return {
      runs: runs.map(r => ({
        id: r.id,
        run_date: r.runDate.toISOString(),
        status: r.status,
        period_start: r.periodStart.toISOString(),
        period_end: r.periodEnd.toISOString(),
        total_records_checked: r.totalRecordsChecked,
        exceptions_found: r.exceptionsFound,
        auto_resolved: r.autoResolved,
        error_message: r.errorMessage,
      })),
    };
  });

  // GET /reconciliation/summary - Get current reconciliation summary
  app.get('/summary', {
    onRequest: [authenticate],
    schema: {
      description: 'Get reconciliation summary (open exceptions count by type/severity)',
      tags: ['Reconciliation'],
    },
  }, async (request) => {
    const tenantId = request.user.tenantId;

    const exceptions = await reconciliationService.getOpenExceptions(tenantId);

    // Group by type and severity
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};

    for (const e of exceptions) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
    }

    return {
      total_open: exceptions.length,
      by_type: byType,
      by_severity: bySeverity,
      critical_count: bySeverity['critical'] || 0,
      high_count: bySeverity['high'] || 0,
    };
  });
}

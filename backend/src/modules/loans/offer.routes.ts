import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { authenticate } from '../../common/middleware/auth.js';

const createOfferSchema = z.object({
  product_id: z.string().uuid(),
  lender_id: z.string().uuid(),
  borrower_id: z.string().uuid(),
  terms: z.object({
    principal_cents: z.number().int().min(10000).max(5000000),
    apr_bps: z.number().int().min(0).max(3600),
    term_months: z.number().int().min(1).max(60),
    payment_frequency: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY']),
    first_payment_date: z.string().optional(),
  }),
  expires_in_hours: z.number().int().min(1).max(720).default(168),
  message: z.string().max(1000).optional(),
});

const acceptOfferSchema = z.object({
  funding_instrument_id: z.string().uuid(),
  disbursement_speed: z.enum(['STANDARD', 'INSTANT']),
  repayment_instrument_id: z.string().uuid().optional(),
  accept_express_fee: z.boolean().optional(),
});

export async function loanOfferRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);

  // POST /loan-offers - Create offer
  app.post('/', {
    schema: {
      description: 'Create a new loan offer',
      tags: ['Loan Offers'],
    },
  }, async (request, reply) => {
    const body = createOfferSchema.parse(request.body);
    const tenantId = request.user.tenantId;

    // Validate product exists
    const product = await app.prisma.loanProduct.findFirst({
      where: { id: body.product_id, tenantId, status: 'ACTIVE' },
    });

    if (!product) {
      throw AppError.notFound('Loan product');
    }

    // TODO: Validate terms against product.termSchema

    // Calculate express fee estimate
    const expressFeeEstimate = calculateExpressFee(body.terms.principal_cents, product.feesPolicy);

    // Check if lender has prefund that would waive fee
    const prefundBalance = await getPrefundBalance(app, body.lender_id);
    const expressFeeWaived = prefundBalance >= body.terms.principal_cents;

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + body.expires_in_hours);

    const offer = await app.prisma.loanOffer.create({
      data: {
        tenantId,
        productId: body.product_id,
        lenderId: body.lender_id,
        borrowerId: body.borrower_id,
        principalCents: body.terms.principal_cents,
        aprBps: body.terms.apr_bps,
        termMonths: body.terms.term_months,
        paymentFrequency: body.terms.payment_frequency,
        firstPaymentDate: body.terms.first_payment_date
          ? new Date(body.terms.first_payment_date)
          : undefined,
        expressFeeEstimateCents: expressFeeEstimate,
        expressFeeWaived,
        message: body.message,
        expiresAt,
      },
    });

    reply.status(201);
    return formatOffer(offer);
  });

  // GET /loan-offers - List offers
  app.get('/', {
    schema: {
      description: 'List loan offers',
      tags: ['Loan Offers'],
    },
  }, async (request) => {
    const { lender_id, borrower_id, status, cursor, limit = 20 } = request.query as {
      lender_id?: string;
      borrower_id?: string;
      status?: string;
      cursor?: string;
      limit?: number;
    };

    const offers = await app.prisma.loanOffer.findMany({
      where: {
        tenantId: request.user.tenantId,
        ...(lender_id && { lenderId: lender_id }),
        ...(borrower_id && { borrowerId: borrower_id }),
        ...(status && { status: status.toUpperCase() as any }),
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = offers.length > limit;
    const data = offers.slice(0, limit);

    return {
      data: data.map(formatOffer),
      next_cursor: hasMore ? data[data.length - 1]?.id : undefined,
      has_more: hasMore,
    };
  });

  // GET /loan-offers/:offer_id
  app.get('/:offer_id', {
    schema: {
      description: 'Get loan offer details',
      tags: ['Loan Offers'],
    },
  }, async (request) => {
    const { offer_id } = request.params as { offer_id: string };

    const offer = await app.prisma.loanOffer.findFirst({
      where: { id: offer_id, tenantId: request.user.tenantId },
    });

    if (!offer) {
      throw AppError.notFound('Loan offer');
    }

    return formatOffer(offer);
  });

  // POST /loan-offers/:offer_id/send
  app.post('/:offer_id/send', {
    schema: {
      description: 'Send offer to borrower',
      tags: ['Loan Offers'],
    },
  }, async (request) => {
    const { offer_id } = request.params as { offer_id: string };

    const offer = await app.prisma.loanOffer.findFirst({
      where: { id: offer_id, tenantId: request.user.tenantId },
    });

    if (!offer) {
      throw AppError.notFound('Loan offer');
    }

    if (offer.status !== 'DRAFT') {
      throw AppError.invalidState('Offer is not in draft status');
    }

    const updated = await app.prisma.loanOffer.update({
      where: { id: offer_id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
      },
    });

    // TODO: Send notification to borrower

    return formatOffer(updated);
  });

  // POST /loan-offers/:offer_id/accept
  app.post('/:offer_id/accept', {
    schema: {
      description: 'Accept loan offer and create contract',
      tags: ['Loan Offers'],
    },
  }, async (request, reply) => {
    const { offer_id } = request.params as { offer_id: string };
    const body = acceptOfferSchema.parse(request.body);

    const offer = await app.prisma.loanOffer.findFirst({
      where: { id: offer_id, tenantId: request.user.tenantId },
    });

    if (!offer) {
      throw AppError.notFound('Loan offer');
    }

    if (!['SENT', 'VIEWED'].includes(offer.status)) {
      throw AppError.invalidState('Offer cannot be accepted in current status');
    }

    // Calculate first payment date if not set
    const firstPaymentDate = offer.firstPaymentDate ?? calculateFirstPaymentDate(offer.paymentFrequency);

    // Create contract in transaction
    const contract = await app.prisma.$transaction(async (tx) => {
      // Update offer status
      await tx.loanOffer.update({
        where: { id: offer_id },
        data: {
          status: 'ACCEPTED',
          respondedAt: new Date(),
        },
      });

      // Create contract
      const contract = await tx.loanContract.create({
        data: {
          tenantId: offer.tenantId,
          offerId: offer.id,
          productId: offer.productId,
          lenderId: offer.lenderId,
          borrowerId: offer.borrowerId,
          principalCents: offer.principalCents,
          aprBps: offer.aprBps,
          termMonths: offer.termMonths,
          paymentFrequency: offer.paymentFrequency,
          firstPaymentDate,
          principalBalanceCents: offer.principalCents,
        },
      });

      // Generate repayment schedule
      const scheduleItems = generateSchedule(contract);
      await tx.repaymentScheduleItem.createMany({
        data: scheduleItems.map((item, index) => ({
          contractId: contract.id,
          sequence: index + 1,
          dueDate: item.dueDate,
          principalCents: item.principalCents,
          interestCents: item.interestCents,
        })),
      });

      return contract;
    });

    reply.status(201);
    return formatContract(contract);
  });

  // POST /loan-offers/:offer_id/reject
  app.post('/:offer_id/reject', {
    schema: {
      description: 'Reject loan offer',
      tags: ['Loan Offers'],
    },
  }, async (request) => {
    const { offer_id } = request.params as { offer_id: string };
    const { reason } = (request.body as { reason?: string }) ?? {};

    const offer = await app.prisma.loanOffer.findFirst({
      where: { id: offer_id, tenantId: request.user.tenantId },
    });

    if (!offer) {
      throw AppError.notFound('Loan offer');
    }

    if (!['SENT', 'VIEWED'].includes(offer.status)) {
      throw AppError.invalidState('Offer cannot be rejected in current status');
    }

    const updated = await app.prisma.loanOffer.update({
      where: { id: offer_id },
      data: {
        status: 'REJECTED',
        respondedAt: new Date(),
        rejectionReason: reason,
      },
    });

    return formatOffer(updated);
  });

  // POST /loan-offers/:offer_id/cancel
  app.post('/:offer_id/cancel', {
    schema: {
      description: 'Cancel loan offer',
      tags: ['Loan Offers'],
    },
  }, async (request) => {
    const { offer_id } = request.params as { offer_id: string };

    const offer = await app.prisma.loanOffer.findFirst({
      where: { id: offer_id, tenantId: request.user.tenantId },
    });

    if (!offer) {
      throw AppError.notFound('Loan offer');
    }

    if (offer.status === 'ACCEPTED') {
      throw AppError.invalidState('Cannot cancel accepted offer');
    }

    const updated = await app.prisma.loanOffer.update({
      where: { id: offer_id },
      data: { status: 'CANCELLED' },
    });

    return formatOffer(updated);
  });
}

// Helper functions
function calculateExpressFee(principalCents: number, feesPolicy: unknown): number {
  // TODO: Parse fees policy and calculate based on bands
  // Simplified version
  if (principalCents <= 50000) return 299;
  if (principalCents <= 200000) return 499;
  if (principalCents <= 500000) return 799;
  if (principalCents <= 1000000) return 999;
  if (principalCents <= 2500000) return 1499;
  return 1999;
}

async function getPrefundBalance(app: FastifyInstance, customerId: string): Promise<number> {
  const lastTx = await app.prisma.prefundTransaction.findFirst({
    where: { customerId, status: 'COMPLETED' },
    orderBy: { createdAt: 'desc' },
  });
  return lastTx?.availableAfterCents ?? 0;
}

function calculateFirstPaymentDate(frequency: string): Date {
  const date = new Date();
  if (frequency === 'WEEKLY') {
    date.setDate(date.getDate() + 14); // 2 weeks
  } else if (frequency === 'BIWEEKLY') {
    date.setDate(date.getDate() + 28); // 4 weeks
  } else {
    date.setMonth(date.getMonth() + 1); // 1 month
  }
  return date;
}

function generateSchedule(contract: {
  principalCents: number;
  aprBps: number;
  termMonths: number;
  paymentFrequency: string;
  firstPaymentDate: Date;
}): Array<{ dueDate: Date; principalCents: number; interestCents: number }> {
  const schedule: Array<{ dueDate: Date; principalCents: number; interestCents: number }> = [];

  const monthlyRate = contract.aprBps / 10000 / 12;
  const numPayments = contract.paymentFrequency === 'MONTHLY'
    ? contract.termMonths
    : contract.paymentFrequency === 'BIWEEKLY'
      ? contract.termMonths * 2
      : contract.termMonths * 4;

  // Amortization calculation
  const paymentAmount = contract.principalCents *
    (monthlyRate * Math.pow(1 + monthlyRate, numPayments)) /
    (Math.pow(1 + monthlyRate, numPayments) - 1);

  let balance = contract.principalCents;
  let currentDate = new Date(contract.firstPaymentDate);

  for (let i = 0; i < numPayments && balance > 0; i++) {
    const interestCents = Math.round(balance * monthlyRate);
    const principalCents = Math.min(Math.round(paymentAmount - interestCents), balance);

    schedule.push({
      dueDate: new Date(currentDate),
      principalCents,
      interestCents,
    });

    balance -= principalCents;

    // Advance date
    if (contract.paymentFrequency === 'WEEKLY') {
      currentDate.setDate(currentDate.getDate() + 7);
    } else if (contract.paymentFrequency === 'BIWEEKLY') {
      currentDate.setDate(currentDate.getDate() + 14);
    } else {
      currentDate.setMonth(currentDate.getMonth() + 1);
    }
  }

  return schedule;
}

function formatOffer(offer: {
  id: string;
  tenantId: string;
  productId: string;
  lenderId: string;
  borrowerId: string;
  status: string;
  principalCents: number;
  aprBps: number;
  termMonths: number;
  paymentFrequency: string;
  firstPaymentDate: Date | null;
  expressFeeEstimateCents: number | null;
  expressFeeWaived: boolean;
  expiresAt: Date;
  createdAt: Date;
  sentAt: Date | null;
  viewedAt: Date | null;
  respondedAt: Date | null;
}) {
  return {
    id: offer.id,
    tenant_id: offer.tenantId,
    product_id: offer.productId,
    lender_id: offer.lenderId,
    borrower_id: offer.borrowerId,
    status: offer.status.toLowerCase(),
    terms: {
      principal_cents: offer.principalCents,
      apr_bps: offer.aprBps,
      term_months: offer.termMonths,
      payment_frequency: offer.paymentFrequency.toLowerCase(),
      first_payment_date: offer.firstPaymentDate?.toISOString().split('T')[0],
    },
    express_fee_estimate_cents: offer.expressFeeEstimateCents,
    express_fee_waived: offer.expressFeeWaived,
    expires_at: offer.expiresAt.toISOString(),
    created_at: offer.createdAt.toISOString(),
    sent_at: offer.sentAt?.toISOString(),
    viewed_at: offer.viewedAt?.toISOString(),
    responded_at: offer.respondedAt?.toISOString(),
  };
}

function formatContract(contract: {
  id: string;
  tenantId: string;
  offerId: string;
  productId: string;
  lenderId: string;
  borrowerId: string;
  status: string;
  principalCents: number;
  aprBps: number;
  termMonths: number;
  paymentFrequency: string;
  firstPaymentDate: Date;
  principalBalanceCents: number;
  interestBalanceCents: number;
  feesBalanceCents: number;
  createdAt: Date;
}) {
  return {
    id: contract.id,
    tenant_id: contract.tenantId,
    offer_id: contract.offerId,
    product_id: contract.productId,
    lender_id: contract.lenderId,
    borrower_id: contract.borrowerId,
    status: contract.status.toLowerCase(),
    terms: {
      principal_cents: contract.principalCents,
      apr_bps: contract.aprBps,
      term_months: contract.termMonths,
      payment_frequency: contract.paymentFrequency.toLowerCase(),
      first_payment_date: contract.firstPaymentDate.toISOString().split('T')[0],
    },
    balances: {
      principal_cents: contract.principalBalanceCents,
      interest_cents: contract.interestBalanceCents,
      fees_cents: contract.feesBalanceCents,
      total_due_cents: contract.principalBalanceCents + contract.interestBalanceCents + contract.feesBalanceCents,
    },
    created_at: contract.createdAt.toISOString(),
  };
}

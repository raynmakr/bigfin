import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { authenticate } from '../../common/middleware/auth.js';

const createCustomerSchema = z.object({
  external_id: z.string().optional(),
  role: z.enum(['BORROWER', 'LENDER', 'BOTH']),
  email: z.string().email(),
  phone: z.string().optional(),
  first_name: z.string(),
  last_name: z.string(),
  business_name: z.string().optional(),
  date_of_birth: z.string().optional(),
  address: z.object({
    line1: z.string(),
    line2: z.string().optional(),
    city: z.string(),
    state: z.string(),
    postal_code: z.string(),
    country: z.string().default('US'),
  }).optional(),
});

const updateCustomerSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.object({
    line1: z.string(),
    line2: z.string().optional(),
    city: z.string(),
    state: z.string(),
    postal_code: z.string(),
    country: z.string(),
  }).optional(),
});

export async function customerRoutes(app: FastifyInstance) {
  // Add authentication to all routes
  app.addHook('onRequest', authenticate);

  // POST /customers - Create customer
  app.post('/', {
    schema: {
      description: 'Create a new end customer (borrower or lender)',
      tags: ['Customers'],
    },
  }, async (request, reply) => {
    const body = createCustomerSchema.parse(request.body);
    const tenantId = request.user.tenantId;

    const customer = await app.prisma.customer.create({
      data: {
        tenantId,
        externalId: body.external_id,
        role: body.role,
        email: body.email,
        phone: body.phone,
        firstName: body.first_name,
        lastName: body.last_name,
        businessName: body.business_name,
        dateOfBirth: body.date_of_birth ? new Date(body.date_of_birth) : undefined,
        addressLine1: body.address?.line1,
        addressLine2: body.address?.line2,
        city: body.address?.city,
        state: body.address?.state,
        postalCode: body.address?.postal_code,
        country: body.address?.country ?? 'US',
      },
    });

    reply.status(201);
    return formatCustomer(customer);
  });

  // GET /customers - List customers
  app.get('/', {
    schema: {
      description: 'List customers with optional filters',
      tags: ['Customers'],
      querystring: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['BORROWER', 'LENDER', 'BOTH'] },
          cursor: { type: 'string' },
          limit: { type: 'number', default: 20 },
        },
      },
    },
  }, async (request) => {
    const { role, cursor, limit = 20 } = request.query as {
      role?: string;
      cursor?: string;
      limit?: number;
    };

    const tenantId = request.user.tenantId;

    const customers = await app.prisma.customer.findMany({
      where: {
        tenantId,
        ...(role && { role: role as 'BORROWER' | 'LENDER' | 'BOTH' }),
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = customers.length > limit;
    const data = customers.slice(0, limit);

    return {
      data: data.map(formatCustomer),
      next_cursor: hasMore ? data[data.length - 1]?.id : undefined,
      has_more: hasMore,
    };
  });

  // GET /customers/:customer_id - Get customer
  app.get('/:customer_id', {
    schema: {
      description: 'Get customer details',
      tags: ['Customers'],
      params: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', format: 'uuid' },
        },
        required: ['customer_id'],
      },
    },
  }, async (request) => {
    const { customer_id } = request.params as { customer_id: string };
    const tenantId = request.user.tenantId;

    const customer = await app.prisma.customer.findFirst({
      where: { id: customer_id, tenantId },
    });

    if (!customer) {
      throw AppError.notFound('Customer');
    }

    return formatCustomer(customer);
  });

  // PATCH /customers/:customer_id - Update customer
  app.patch('/:customer_id', {
    schema: {
      description: 'Update customer details',
      tags: ['Customers'],
    },
  }, async (request) => {
    const { customer_id } = request.params as { customer_id: string };
    const body = updateCustomerSchema.parse(request.body);
    const tenantId = request.user.tenantId;

    const customer = await app.prisma.customer.update({
      where: { id: customer_id },
      data: {
        ...(body.email && { email: body.email }),
        ...(body.phone && { phone: body.phone }),
        ...(body.address && {
          addressLine1: body.address.line1,
          addressLine2: body.address.line2,
          city: body.address.city,
          state: body.address.state,
          postalCode: body.address.postal_code,
          country: body.address.country,
        }),
      },
    });

    return formatCustomer(customer);
  });

  // GET /customers/:customer_id/kyc - Get KYC status
  app.get('/:customer_id/kyc', {
    schema: {
      description: 'Get customer KYC status',
      tags: ['Customers'],
    },
  }, async (request) => {
    const { customer_id } = request.params as { customer_id: string };
    const tenantId = request.user.tenantId;

    const customer = await app.prisma.customer.findFirst({
      where: { id: customer_id, tenantId },
    });

    if (!customer) {
      throw AppError.notFound('Customer');
    }

    return {
      customer_id: customer.id,
      level: customer.kycLevel.toLowerCase(),
      status: customer.kycStatus.toLowerCase(),
      submitted_at: customer.kycSubmittedAt?.toISOString(),
      verified_at: customer.kycVerifiedAt?.toISOString(),
      expires_at: customer.kycExpiresAt?.toISOString(),
    };
  });

  // POST /customers/:customer_id/kyc - Submit KYC
  app.post('/:customer_id/kyc', {
    schema: {
      description: 'Submit KYC verification',
      tags: ['Customers'],
    },
  }, async (request, reply) => {
    const { customer_id } = request.params as { customer_id: string };
    const body = request.body as {
      level: 'basic' | 'enhanced';
      ssn_last4?: string;
      date_of_birth?: string;
    };
    const tenantId = request.user.tenantId;

    const customer = await app.prisma.customer.update({
      where: { id: customer_id },
      data: {
        kycLevel: body.level.toUpperCase() as 'BASIC' | 'ENHANCED',
        kycStatus: 'PENDING',
        kycSubmittedAt: new Date(),
        ...(body.date_of_birth && { dateOfBirth: new Date(body.date_of_birth) }),
      },
    });

    // TODO: Trigger actual KYC verification with provider

    reply.status(202);
    return {
      customer_id: customer.id,
      level: customer.kycLevel.toLowerCase(),
      status: 'pending',
      submitted_at: customer.kycSubmittedAt?.toISOString(),
    };
  });
}

function formatCustomer(customer: {
  id: string;
  tenantId: string;
  externalId: string | null;
  role: string;
  email: string;
  phone: string | null;
  firstName: string;
  lastName: string;
  businessName: string | null;
  kycLevel: string;
  riskTier: string;
  riskFlags: string[];
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: customer.id,
    tenant_id: customer.tenantId,
    external_id: customer.externalId,
    role: customer.role.toLowerCase(),
    email: customer.email,
    phone: customer.phone,
    first_name: customer.firstName,
    last_name: customer.lastName,
    business_name: customer.businessName,
    kyc_level: customer.kycLevel.toLowerCase(),
    risk_tier: customer.riskTier.toLowerCase(),
    risk_flags: customer.riskFlags,
    created_at: customer.createdAt.toISOString(),
    updated_at: customer.updatedAt.toISOString(),
  };
}

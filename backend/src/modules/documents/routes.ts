import type { FastifyInstance } from 'fastify';
import { AppError } from '../../common/errors/app-error.js';
import { authenticate } from '../../common/middleware/auth.js';

export async function documentRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);

  // GET /documents/:document_id
  app.get('/:document_id', {
    schema: {
      description: 'Get document metadata',
      tags: ['Documents'],
    },
  }, async (request) => {
    const { document_id } = request.params as { document_id: string };

    const doc = await app.prisma.document.findUnique({
      where: { id: document_id },
      include: { contract: true },
    });

    if (!doc || (doc.contract && doc.contract.tenantId !== request.user.tenantId)) {
      throw AppError.notFound('Document');
    }

    return {
      id: doc.id,
      contract_id: doc.contractId,
      document_type: doc.type.toLowerCase(),
      filename: doc.filename,
      content_type: doc.contentType,
      size_bytes: doc.sizeBytes,
      sha256: doc.sha256,
      description: doc.description,
      uploaded_by: doc.uploadedById,
      created_at: doc.createdAt.toISOString(),
    };
  });

  // GET /documents/:document_id/download
  app.get('/:document_id/download', {
    schema: {
      description: 'Download document',
      tags: ['Documents'],
    },
  }, async (request, reply) => {
    const { document_id } = request.params as { document_id: string };

    const doc = await app.prisma.document.findUnique({
      where: { id: document_id },
      include: { contract: true },
    });

    if (!doc || (doc.contract && doc.contract.tenantId !== request.user.tenantId)) {
      throw AppError.notFound('Document');
    }

    // TODO: Fetch from storage (S3, etc.) and stream

    reply.header('Content-Type', doc.contentType);
    reply.header('Content-Disposition', `attachment; filename="${doc.filename}"`);

    return reply.send(Buffer.from('TODO: Implement storage download'));
  });

  // POST /loan-contracts/:contract_id/documents
  app.post('/loan-contracts/:contract_id/documents', {
    schema: {
      description: 'Upload document',
      tags: ['Documents'],
    },
  }, async (request, reply) => {
    const { contract_id } = request.params as { contract_id: string };

    const contract = await app.prisma.loanContract.findFirst({
      where: { id: contract_id, tenantId: request.user.tenantId },
    });

    if (!contract) {
      throw AppError.notFound('Loan contract');
    }

    // TODO: Handle multipart file upload
    // TODO: Upload to storage
    // TODO: Create document record

    reply.status(501);
    return { error: 'File upload not yet implemented' };
  });

  // GET /loan-contracts/:contract_id/documents
  app.get('/loan-contracts/:contract_id/documents', {
    schema: {
      description: 'List documents for a contract',
      tags: ['Documents'],
    },
  }, async (request) => {
    const { contract_id } = request.params as { contract_id: string };
    const { document_type, cursor, limit = 20 } = request.query as {
      document_type?: string;
      cursor?: string;
      limit?: number;
    };

    const docs = await app.prisma.document.findMany({
      where: {
        contractId: contract_id,
        ...(document_type && { type: document_type.toUpperCase() as any }),
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = docs.length > limit;
    const data = docs.slice(0, limit);

    return {
      data: data.map((doc) => ({
        id: doc.id,
        document_type: doc.type.toLowerCase(),
        filename: doc.filename,
        size_bytes: doc.sizeBytes,
        created_at: doc.createdAt.toISOString(),
      })),
      next_cursor: hasMore ? data[data.length - 1]?.id : undefined,
      has_more: hasMore,
    };
  });
}

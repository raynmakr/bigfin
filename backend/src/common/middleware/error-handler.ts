import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, ErrorCode } from '../errors/app-error.js';

interface ErrorResponse {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const requestId = request.id;

  // Log the error
  request.log.error({ err: error, requestId }, 'Request error');

  // Handle AppError (our custom errors)
  if (error instanceof AppError) {
    const response: ErrorResponse = {
      code: error.code,
      message: error.message,
      requestId,
    };

    if (error.details) {
      response.details = error.details;
    }

    return reply.status(error.statusCode).send(response);
  }

  // Handle Zod validation errors
  if (error instanceof ZodError) {
    const response: ErrorResponse = {
      code: ErrorCode.INVALID_REQUEST,
      message: 'Validation failed',
      details: {
        errors: error.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      },
      requestId,
    };

    return reply.status(400).send(response);
  }

  // Handle Fastify validation errors
  if ('validation' in error && error.validation) {
    const response: ErrorResponse = {
      code: ErrorCode.INVALID_REQUEST,
      message: error.message,
      details: {
        validation: error.validation,
      },
      requestId,
    };

    return reply.status(400).send(response);
  }

  // Handle Prisma errors
  if (error.name === 'PrismaClientKnownRequestError') {
    const prismaError = error as { code: string; meta?: Record<string, unknown> };

    if (prismaError.code === 'P2002') {
      // Unique constraint violation
      const response: ErrorResponse = {
        code: ErrorCode.ALREADY_EXISTS,
        message: 'Resource already exists',
        details: prismaError.meta,
        requestId,
      };
      return reply.status(409).send(response);
    }

    if (prismaError.code === 'P2025') {
      // Record not found
      const response: ErrorResponse = {
        code: ErrorCode.NOT_FOUND,
        message: 'Resource not found',
        requestId,
      };
      return reply.status(404).send(response);
    }
  }

  // Handle JWT errors
  if (error.name === 'UnauthorizedError' || error.message?.includes('jwt')) {
    const response: ErrorResponse = {
      code: ErrorCode.UNAUTHORIZED,
      message: 'Invalid or expired token',
      requestId,
    };
    return reply.status(401).send(response);
  }

  // Default to internal server error
  const response: ErrorResponse = {
    code: ErrorCode.INTERNAL_ERROR,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
    requestId,
  };

  return reply.status(500).send(response);
}

export enum ErrorCode {
  // Authentication/Authorization
  UNAUTHORIZED = 'unauthorized',
  FORBIDDEN = 'forbidden',
  STEP_UP_REQUIRED = 'step_up_required',

  // Validation
  INVALID_REQUEST = 'invalid_request',
  INVALID_PARAMETER = 'invalid_parameter',
  TERMS_OUT_OF_POLICY = 'terms_out_of_policy',

  // State
  INVALID_STATE = 'invalid_state',
  ALREADY_EXISTS = 'already_exists',
  NOT_FOUND = 'not_found',

  // Payment
  INSUFFICIENT_FUNDS = 'insufficient_funds',
  INSTRUMENT_INVALID = 'instrument_invalid',
  PAYMENT_FAILED = 'payment_failed',
  PAYMENT_RETURNED = 'payment_returned',

  // Limits
  LIMIT_EXCEEDED = 'limit_exceeded',
  RATE_LIMITED = 'rate_limited',

  // System
  INTERNAL_ERROR = 'internal_error',
  SERVICE_UNAVAILABLE = 'service_unavailable',
  PROVIDER_ERROR = 'provider_error',
}

const statusCodeMap: Record<ErrorCode, number> = {
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.STEP_UP_REQUIRED]: 403,
  [ErrorCode.INVALID_REQUEST]: 400,
  [ErrorCode.INVALID_PARAMETER]: 400,
  [ErrorCode.TERMS_OUT_OF_POLICY]: 400,
  [ErrorCode.INVALID_STATE]: 409,
  [ErrorCode.ALREADY_EXISTS]: 409,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.INSUFFICIENT_FUNDS]: 400,
  [ErrorCode.INSTRUMENT_INVALID]: 400,
  [ErrorCode.PAYMENT_FAILED]: 400,
  [ErrorCode.PAYMENT_RETURNED]: 400,
  [ErrorCode.LIMIT_EXCEEDED]: 400,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
  [ErrorCode.PROVIDER_ERROR]: 502,
};

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCodeMap[code];
    this.details = details;

    // Maintains proper stack trace
    Error.captureStackTrace(this, this.constructor);
  }

  static unauthorized(message = 'Authentication required') {
    return new AppError(ErrorCode.UNAUTHORIZED, message);
  }

  static forbidden(message = 'Access denied') {
    return new AppError(ErrorCode.FORBIDDEN, message);
  }

  static notFound(resource = 'Resource') {
    return new AppError(ErrorCode.NOT_FOUND, `${resource} not found`);
  }

  static invalidState(message: string) {
    return new AppError(ErrorCode.INVALID_STATE, message);
  }

  static invalidRequest(message: string, details?: Record<string, unknown>) {
    return new AppError(ErrorCode.INVALID_REQUEST, message, details);
  }

  static alreadyExists(resource = 'Resource') {
    return new AppError(ErrorCode.ALREADY_EXISTS, `${resource} already exists`);
  }

  static insufficientFunds(message = 'Insufficient funds') {
    return new AppError(ErrorCode.INSUFFICIENT_FUNDS, message);
  }

  static termsOutOfPolicy(message: string, details?: Record<string, unknown>) {
    return new AppError(ErrorCode.TERMS_OUT_OF_POLICY, message, details);
  }

  static providerError(message: string, details?: Record<string, unknown>) {
    return new AppError(ErrorCode.PROVIDER_ERROR, message, details);
  }
}

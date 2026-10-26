/** Errors the API turns into `{ error: { code, message, details } }` responses. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super(404, 'NOT_FOUND', id ? `${entity} ${id} not found` : `${entity} not found`);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details);
  }
}

export class ValidationError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(400, code, message, details);
  }
}

/**
 * A money rule said no: insufficient funds, frozen account, limit reached.
 * A transfer that hits one of these is saved as FAILED rather than discarded.
 */
export class BusinessRuleError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(422, code, message, details);
  }
}

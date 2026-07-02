import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/httpError';
import { logger } from '../lib/logger';
import { REQUEST_ID_HEADER } from './requestId';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'not_found',
    message: `No route configured for ${req.method} ${req.path}`,
    requestId: req.headers[REQUEST_ID_HEADER],
  });
}

// Express recognizes error-handling middleware by arity (4 args) -- keep all four.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.headers[REQUEST_ID_HEADER];

  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation_error', message: 'Invalid request body', requestId, details: err.issues });
    return;
  }

  if (err instanceof HttpError) {
    if (err.status >= 500) {
      logger.error({ err, requestId }, 'request failed');
    } else {
      logger.warn({ code: err.code, requestId }, 'request rejected');
    }
    res.status(err.status).json({ error: err.code, message: err.message, requestId, details: err.details });
    return;
  }

  logger.error({ err, requestId }, 'unhandled error');
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong', requestId });
}

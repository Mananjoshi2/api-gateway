import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Ensures every request has an x-request-id, generating one if the caller
 * didn't send it. Because it's set on req.headers before the proxy runs,
 * http-proxy-middleware forwards it upstream automatically -- one id traces
 * a request across gateway -> upstream in both sets of logs.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const existing = req.headers[REQUEST_ID_HEADER];
  const id = (Array.isArray(existing) ? existing[0] : existing) || uuidv4();
  req.headers[REQUEST_ID_HEADER] = id;
  res.setHeader('X-Request-Id', id);
  next();
}

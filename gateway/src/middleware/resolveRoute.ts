import { Request, Response, NextFunction } from 'express';
import { ConfigStore } from '../config/configStore';
import { HttpError } from '../lib/httpError';

/** Matches the incoming path against routes.yaml and attaches it to the request. */
export function resolveRoute(configStore: ConfigStore) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const route = configStore.matchRoute(req.path);
    if (!route) {
      next(new HttpError(404, 'route_not_found', `No upstream configured for ${req.path}`));
      return;
    }
    req.gatewayRoute = route;
    next();
  };
}

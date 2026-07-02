import { RouteConfig } from '../config/schema';

declare global {
  namespace Express {
    interface Request {
      gatewayRoute?: RouteConfig;
      gatewayProxyStart?: number;
      auth?: {
        userId: string;
        email: string;
        tier: string;
        apiKey: string;
      };
    }
  }
}

export {};

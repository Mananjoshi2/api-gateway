import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { gatewayConfigSchema, GatewayConfig, RouteConfig, Tier } from './schema';
import { logger } from '../lib/logger';

/**
 * Loads gateway routing config from a YAML file and keeps it in memory.
 * Watches the file for edits so route/tier changes apply without a restart.
 * Runtime overrides (e.g. rollback flipping activeVersion) live only in memory
 * and are reset by the next file-triggered reload -- that's intentional: the
 * YAML file is the source of truth, admin/rollback actions are a temporary override.
 */
export class ConfigStore {
  private config: GatewayConfig;

  constructor(private readonly filePath: string) {
    this.config = this.readFromDisk();
    this.watch();
  }

  private readFromDisk(): GatewayConfig {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const parsed = yaml.load(raw);
    const result = gatewayConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid gateway config at ${this.filePath}: ${result.error.message}`);
    }
    return result.data;
  }

  private watch(): void {
    fs.watch(path.dirname(this.filePath), (_event, filename) => {
      if (filename !== path.basename(this.filePath)) return;
      try {
        this.config = this.readFromDisk();
        logger.info({ file: this.filePath }, 'gateway config reloaded from disk');
      } catch (err) {
        logger.error({ err }, 'failed to reload gateway config, keeping previous config');
      }
    });
  }

  getTiers(): Record<string, Tier> {
    return this.config.tiers;
  }

  getTier(name: string): Tier | undefined {
    return this.config.tiers[name];
  }

  getRoutes(): RouteConfig[] {
    return this.config.routes;
  }

  /** Longest-prefix match: /api/users matches /api/users and /api/users/42 */
  matchRoute(requestPath: string): RouteConfig | undefined {
    let best: RouteConfig | undefined;
    for (const route of this.config.routes) {
      const isMatch = requestPath === route.path || requestPath.startsWith(`${route.path}/`);
      if (isMatch && (!best || route.path.length > best.path.length)) {
        best = route;
      }
    }
    return best;
  }

  /** Runtime override used by the rollback/circuit-breaker and admin endpoints. */
  setActiveVersion(routePath: string, version: string): boolean {
    const route = this.config.routes.find((r) => r.path === routePath);
    if (!route || !route.versions || !(version in route.versions)) return false;
    route.activeVersion = version;
    return true;
  }
}

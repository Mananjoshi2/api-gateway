import path from 'path';
import { createApp } from './app';
import { ConfigStore } from './config/configStore';
import { redis } from './lib/redis';
import { logger } from './lib/logger';

const PORT = parseInt(process.env.PORT || '8080', 10);
const CONFIG_PATH = process.env.ROUTES_CONFIG_PATH || path.join(__dirname, '..', 'config', 'routes.yaml');

const configStore = new ConfigStore(CONFIG_PATH);
const app = createApp(configStore, redis);

app.listen(PORT, () => {
  logger.info({ port: PORT, config: CONFIG_PATH }, 'gateway listening');
});

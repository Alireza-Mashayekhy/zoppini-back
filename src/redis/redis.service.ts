import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: RedisClientType;

  async onModuleInit() {
    const host = process.env.REDIS_HOST?.trim() || '127.0.0.1';
    const parsedPort = Number(process.env.REDIS_PORT);
    const port =
      Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 6379;
    const password = process.env.REDIS_PASSWORD?.trim() || undefined;

    this.client = createClient({
      socket: {
        host,
        port,
      },
      ...(password ? { password } : {}),
    });

    this.client.on('error', err => {
      this.logger.error(
        `Redis client error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    await this.client.connect();

    this.logger.log(`Redis connected (${host}:${port})`);
  }

  async onModuleDestroy() {
    if (this.client?.isOpen) {
      await this.client.quit().catch(() => undefined);
    }
  }

  getClient() {
    return this.client;
  }
}

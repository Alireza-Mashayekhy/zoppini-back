import { ServiceUnavailableException } from '@nestjs/common';

import { BotRole, BotScope } from '../bot.constants';
import { BotAuthService } from './bot-auth.service';

const ENV_KEYS = [
  'BOT_API_KEY',
  'BOT_API_KEY_PREVIOUS',
  'BOT_OWNER_TELEGRAM_IDS',
  'BOT_ADMIN_TELEGRAM_IDS',
  'BOT_REPORTS_READONLY_TELEGRAM_IDS',
  'BOT_ORDERS_READONLY_TELEGRAM_IDS',
];

describe('BotAuthService', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it('fails closed when no valid key is configured', () => {
    process.env.BOT_API_KEY = 'too-short';

    expect(() => new BotAuthService().verifyApiKey('too-short')).toThrow(
      ServiceUnavailableException,
    );
  });

  it('accepts current and previous keys using constant-time digest compare', () => {
    const current = 'a'.repeat(64);
    const previous = 'b'.repeat(64);

    process.env.BOT_API_KEY = current;
    process.env.BOT_API_KEY_PREVIOUS = previous;

    const service = new BotAuthService();

    expect(service.verifyApiKey(current)).toBe(true);
    expect(service.verifyApiKey(previous)).toBe(true);
    expect(service.verifyApiKey('c'.repeat(64))).toBe(false);
    expect(service.verifyApiKey(undefined)).toBe(false);
  });

  it('resolves role precedence and scopes from the server allowlist', () => {
    process.env.BOT_API_KEY = 'a'.repeat(64);
    process.env.BOT_OWNER_TELEGRAM_IDS = '100';
    process.env.BOT_ADMIN_TELEGRAM_IDS = '200';
    process.env.BOT_REPORTS_READONLY_TELEGRAM_IDS = '300,100';
    process.env.BOT_ORDERS_READONLY_TELEGRAM_IDS = '400';

    const service = new BotAuthService();

    expect(service.resolvePrincipal('100')).toEqual({
      telegramUserId: '100',
      role: BotRole.OWNER,
      scopes: [BotScope.REPORTS, BotScope.ORDERS, BotScope.INVENTORY],
    });

    expect(service.resolvePrincipal('300')?.role).toBe(
      BotRole.REPORTS_READONLY,
    );
    expect(service.resolvePrincipal('300')?.scopes).toEqual([BotScope.REPORTS]);
    expect(service.resolvePrincipal('400')?.scopes).toEqual([BotScope.ORDERS]);
    expect(service.resolvePrincipal('999')).toBeNull();
    expect(service.resolvePrincipal('not-a-number')).toBeNull();
  });
});

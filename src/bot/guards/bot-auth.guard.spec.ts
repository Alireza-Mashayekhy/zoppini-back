import {
  ExecutionContext,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  BOT_API_KEY_HEADER,
  BOT_CHAT_TYPE_HEADER,
  BOT_TELEGRAM_USER_HEADER,
  BotScope,
} from '../bot.constants';
import { BOT_SCOPES_KEY } from '../decorators/bot-scopes.decorator';
import { BotAuthService } from '../services/bot-auth.service';
import { BotAuthGuard } from './bot-auth.guard';

const ENV_KEYS = [
  'BOT_API_KEY',
  'BOT_API_KEY_PREVIOUS',
  'BOT_OWNER_TELEGRAM_IDS',
  'BOT_ORDERS_READONLY_TELEGRAM_IDS',
  'BOT_REQUIRE_TLS',
  'NODE_ENV',
];

const VALID_KEY = 'a'.repeat(64);

function createContext(
  headers: Record<string, string>,
  { secure = false, protocol = 'http' } = {},
  scopes?: BotScope[],
): ExecutionContext {
  const handler = () => undefined;

  if (scopes) {
    Reflect.defineMetadata(BOT_SCOPES_KEY, scopes, handler);
  }

  const request = {
    headers,
    secure,
    protocol,
  };

  return {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function validHeaders(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    [BOT_API_KEY_HEADER]: VALID_KEY,
    [BOT_TELEGRAM_USER_HEADER]: '100',
    [BOT_CHAT_TYPE_HEADER]: 'private',
    ...overrides,
  };
}

describe('BotAuthGuard', () => {
  const originalEnv: Record<string, string | undefined> = {};
  let guard: BotAuthGuard;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
    }

    process.env.NODE_ENV = 'test';
    process.env.BOT_API_KEY = VALID_KEY;
    process.env.BOT_OWNER_TELEGRAM_IDS = '100';
    process.env.BOT_ORDERS_READONLY_TELEGRAM_IDS = '200';
    delete process.env.BOT_API_KEY_PREVIOUS;
    delete process.env.BOT_REQUIRE_TLS;

    guard = new BotAuthGuard(new BotAuthService(), new Reflector());
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

  it('accepts an allowlisted owner in a private chat', () => {
    expect(guard.canActivate(createContext(validHeaders()))).toBe(true);
  });

  it('rejects non-private chats', () => {
    expect(() =>
      guard.canActivate(
        createContext(validHeaders({ [BOT_CHAT_TYPE_HEADER]: 'group' })),
      ),
    ).toThrow(ForbiddenException);
  });

  it('fails closed when the server has no valid bot key', () => {
    delete process.env.BOT_API_KEY;

    expect(() =>
      guard.canActivate(
        createContext({
          [BOT_TELEGRAM_USER_HEADER]: '100',
          [BOT_CHAT_TYPE_HEADER]: 'private',
        }),
      ),
    ).toThrow(ServiceUnavailableException);
  });

  it('rejects invalid and missing API keys', () => {
    expect(() =>
      guard.canActivate(
        createContext(validHeaders({ [BOT_API_KEY_HEADER]: 'b'.repeat(64) })),
      ),
    ).toThrow(UnauthorizedException);

    expect(() =>
      guard.canActivate(
        createContext({
          [BOT_TELEGRAM_USER_HEADER]: '100',
          [BOT_CHAT_TYPE_HEADER]: 'private',
        }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a Telegram ID that is not in the server allowlist', () => {
    expect(() =>
      guard.canActivate(
        createContext(validHeaders({ [BOT_TELEGRAM_USER_HEADER]: '999' })),
      ),
    ).toThrow(ForbiddenException);
  });

  it('enforces endpoint scopes', () => {
    expect(() =>
      guard.canActivate(
        createContext(validHeaders({ [BOT_TELEGRAM_USER_HEADER]: '200' }), {}, [
          BotScope.REPORTS,
        ]),
      ),
    ).toThrow(ForbiddenException);

    expect(
      guard.canActivate(
        createContext(validHeaders({ [BOT_TELEGRAM_USER_HEADER]: '200' }), {}, [
          BotScope.ORDERS,
        ]),
      ),
    ).toBe(true);
  });

  it('rejects plain HTTP when TLS is required', () => {
    process.env.BOT_REQUIRE_TLS = 'true';

    expect(() => guard.canActivate(createContext(validHeaders()))).toThrow(
      ForbiddenException,
    );

    expect(
      guard.canActivate(
        createContext(validHeaders(), {
          secure: true,
          protocol: 'https',
        }),
      ),
    ).toBe(true);

    expect(
      guard.canActivate(
        createContext(
          {
            ...validHeaders(),
            'x-forwarded-proto': 'https',
          },
          { secure: false, protocol: 'http' },
        ),
      ),
    ).toBe(true);
  });
});

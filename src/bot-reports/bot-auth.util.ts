import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const BOT_ACTOR_ID_HEADER = 'x-bot-actor-id';
export const BOT_CHAT_TYPE_HEADER = 'x-bot-chat-type';
export const BOT_TIMESTAMP_HEADER = 'x-bot-timestamp';
export const BOT_NONCE_HEADER = 'x-bot-nonce';
export const BOT_SIGNATURE_HEADER = 'x-bot-signature';

/** حداکثر اختلاف ساعت مجاز برای جلوگیری از Replay Attack (۵ دقیقه) */
export const BOT_SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

export interface BotSignatureFields {
  timestamp: string;
  nonce: string;
  method: string;
  pathWithQuery: string;
  actorId: string;
  chatType: string;
  bodySha256: string;
}

/**
 * سریال‌سازی قطعی (Canonical JSON) برای بدنهٔ درخواست تا هش بدنه بین `fetch`
 * ربات و `req.body` پارس‌شده در Express همیشه یکسان باشد.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort();

    if (keys.length === 0) {
      return '{}';
    }

    return `{${keys
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }

  return '';
}

export function computeBodySha256(body: unknown): string {
  let serialized = '';

  if (body === undefined || body === null || body === '') {
    serialized = '';
  } else if (Buffer.isBuffer(body)) {
    return createHash('sha256').update(body).digest('hex');
  } else if (typeof body === 'object') {
    const keys = Object.keys(body);
    serialized = keys.length === 0 ? '' : canonicalJson(body);
  } else if (typeof body === 'string') {
    serialized = body;
  } else {
    serialized = canonicalJson(body);
  }

  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

export function deriveActorSigningKey(
  serviceToken: string,
  explicitSigningSecret?: string | null,
): string {
  const trimmedExplicit = explicitSigningSecret?.trim();

  if (trimmedExplicit) {
    return trimmedExplicit;
  }

  return createHmac('sha256', serviceToken)
    .update('zoppini-bot-actor-signing-v1', 'utf8')
    .digest('hex');
}

export function buildSignaturePayload(fields: BotSignatureFields): string {
  return [
    'v1',
    fields.timestamp,
    fields.nonce,
    fields.method.toUpperCase(),
    fields.pathWithQuery,
    fields.actorId,
    fields.chatType,
    fields.bodySha256,
  ].join('\n');
}

export function computeBotRequestSignature(
  signingKey: string,
  fields: BotSignatureFields,
): string {
  return createHmac('sha256', signingKey)
    .update(buildSignaturePayload(fields), 'utf8')
    .digest('hex');
}

export function safeTimingEqual(supplied: string, expected: string): boolean {
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (
    suppliedBuffer.length === 0 ||
    suppliedBuffer.length !== expectedBuffer.length
  ) {
    return false;
  }

  return timingSafeEqual(suppliedBuffer, expectedBuffer);
}

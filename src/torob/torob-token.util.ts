import { createPublicKey, KeyObject, verify as cryptoVerify } from 'crypto';

import {
  TOROB_CLOCK_SKEW_SECONDS,
  TOROB_PUBLIC_KEY_PEM,
} from './torob.constants';

export interface TorobTokenHeader {
  alg: string;
  typ?: string;
  v?: number;
}

export interface TorobTokenPayload {
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
}

export interface TorobVerifiedToken {
  header: TorobTokenHeader;
  payload: TorobTokenPayload;
}

/**
 * کلید عمومی فقط یک‌بار ساخته می‌شود (ساخت KeyObject عملیات نسبتاً سنگینی است).
 *
 * امکان بازنویسی کلید از طریق `TOROB_PUBLIC_KEY` وجود دارد تا اگر ترب کلید را
 * عوض کرد بدون deploy قابل به‌روزرسانی باشد. در صورت تنظیم اشتباه، تمام
 * درخواست‌ها رد می‌شوند (fail-closed) و نشت اطلاعاتی رخ نمی‌دهد.
 */
let cachedPublicKey: KeyObject | null = null;
let cachedPublicKeySource: string | null = null;

function getPublicKeyPem(): string {
  const fromEnv = process.env.TOROB_PUBLIC_KEY?.trim();

  if (fromEnv) {
    return fromEnv.includes('BEGIN PUBLIC KEY')
      ? fromEnv
      : `-----BEGIN PUBLIC KEY-----\n${fromEnv}\n-----END PUBLIC KEY-----`;
  }

  return TOROB_PUBLIC_KEY_PEM;
}

function getPublicKey(): KeyObject {
  const pem = getPublicKeyPem();

  if (!cachedPublicKey || cachedPublicKeySource !== pem) {
    cachedPublicKey = createPublicKey(pem);
    cachedPublicKeySource = pem;
  }

  return cachedPublicKey;
}

/** تبدیل base64url به Buffer (توکن JWT از base64url استفاده می‌کند نه base64 معمولی) */
function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;

  return Buffer.from(
    padding ? normalized + '='.repeat(4 - padding) : normalized,
    'base64',
  );
}

function parseJsonSegment<T>(segment: string, label: string): T {
  try {
    return JSON.parse(decodeBase64Url(segment).toString('utf8'));
  } catch {
    throw new TorobTokenError(`token ${label} is not valid JSON`);
  }
}

/**
 * اعتبارسنجی کامل توکن ترب:
 *  ۱) ساختار سه‌بخشی JWT
 *  ۲) الگوریتم EdDSA (جلوگیری از حمله algorithm confusion)
 *  ۳) امضای معتبر با کلید عمومی ترب
 *  ۴) نسخه توکن (v)
 *  ۵) زمان انقضا (exp) و زمان شروع اعتبار (nbf)
 *
 * بررسی `aud` جداگانه و اجباری است و در گارد انجام می‌شود.
 */
export function verifyTorobToken(
  token: string,
  expectedAudience: string | null,
): TorobVerifiedToken {
  if (!token || typeof token !== 'string') {
    throw new TorobTokenError('X-Torob-Token header is missing');
  }

  const parts = token.split('.');

  if (parts.length !== 3 || parts.some(part => part.length === 0)) {
    throw new TorobTokenError('token is not a valid JWT');
  }

  const [headerSegment, payloadSegment, signatureSegment] = parts;

  const header = parseJsonSegment<TorobTokenHeader>(headerSegment, 'header');

  if (header?.alg !== 'EdDSA') {
    throw new TorobTokenError(
      `unsupported token algorithm: ${header?.alg ?? 'unknown'}`,
    );
  }

  if (header.typ && header.typ.toUpperCase() !== 'JWT') {
    throw new TorobTokenError(`unsupported token type: ${header.typ}`);
  }

  if (header.v !== undefined && Number(header.v) !== 1) {
    throw new TorobTokenError(`unsupported token version: ${header.v}`);
  }

  const signature = decodeBase64Url(signatureSegment);

  const isSignatureValid = cryptoVerify(
    null,
    Buffer.from(`${headerSegment}.${payloadSegment}`, 'utf8'),
    getPublicKey(),
    signature,
  );

  if (!isSignatureValid) {
    throw new TorobTokenError('token signature is not valid');
  }

  const payload = parseJsonSegment<TorobTokenPayload>(
    payloadSegment,
    'payload',
  );

  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp !== 'number') {
    throw new TorobTokenError('token exp claim is missing');
  }

  if (payload.exp + TOROB_CLOCK_SKEW_SECONDS < now) {
    throw new TorobTokenError('token is expired');
  }

  if (
    typeof payload.nbf === 'number' &&
    payload.nbf - TOROB_CLOCK_SKEW_SECONDS > now
  ) {
    throw new TorobTokenError('token is not active yet');
  }

  if (expectedAudience) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

    if (!audiences.includes(expectedAudience)) {
      throw new TorobTokenError(
        `token audience is not valid for this endpoint (expected: ${expectedAudience})`,
      );
    }
  }

  return { header, payload };
}

export class TorobTokenError extends Error {
  constructor(message: string) {
    super(message);

    this.name = 'TorobTokenError';
  }
}

import { createHmac, timingSafeEqual } from 'crypto';

export const TOROB_CLICK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLID = /^[A-Za-z0-9_-]{1,255}$/;
export type TorobAttribution = {
  purpose: 'torob-click';
  grantId: string;
  clid: string;
  clickedAt: number;
};

export function validGrantId(id: unknown): id is string {
  return typeof id === 'string' && UUID.test(id);
}
export function verifyAttribution(
  token: unknown,
  secret: string | undefined,
  now = Date.now(),
): TorobAttribution | null {
  try {
    if (
      typeof token !== 'string' ||
      token.length > 1024 ||
      !secret ||
      secret.length < 32
    )
      return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, signature] = parts;
    const expected = createHmac('sha256', secret)
      .update(body)
      .digest('base64url');
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return null;
    const value = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as TorobAttribution;
    if (
      value.purpose !== 'torob-click' ||
      !validGrantId(value.grantId) ||
      typeof value.clid !== 'string' ||
      !CLID.test(value.clid) ||
      !Number.isSafeInteger(value.clickedAt) ||
      value.clickedAt > now ||
      now - value.clickedAt >= TOROB_CLICK_WINDOW_MS
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

import { AxiosError } from 'axios';

import {
  createCorrelationId,
  maskMobile,
  sanitizeForLog,
  serializeError,
  structuredLog,
  truncateForLog,
} from './structured-logger';

describe('structured-logger', () => {
  describe('createCorrelationId', () => {
    it('creates unique ids with the given prefix', () => {
      const a = createCorrelationId('rah-inv');
      const b = createCorrelationId('rah-inv');

      expect(a).toMatch(/^rah-inv-[0-9a-f-]{36}$/);
      expect(a).not.toBe(b);
    });
  });

  describe('structuredLog', () => {
    it('emits single-line JSON with event first', () => {
      const line = structuredLog('rahkaran.invoice.sync.start', {
        correlationId: 'abc',
        orderId: 12,
        finalPriceToman: 1200000,
      });

      expect(line).not.toContain('\n');

      const parsed = JSON.parse(line);
      expect(Object.keys(parsed)[0]).toBe('event');
      expect(parsed).toEqual({
        event: 'rahkaran.invoice.sync.start',
        correlationId: 'abc',
        orderId: 12,
        finalPriceToman: 1200000,
      });
    });

    it('skips undefined fields and masks sensitive keys', () => {
      const line = structuredLog('test.event', {
        correlationId: 'abc',
        password: 'super-secret',
        apiKey: 'key-123',
        nested: { accessToken: 'tok', ok: 1 },
        missing: undefined,
      });

      const parsed = JSON.parse(line);
      expect(parsed.password).toBe('***');
      expect(parsed.apiKey).toBe('***');
      expect(parsed.nested.accessToken).toBe('***');
      expect(parsed.nested.ok).toBe(1);
      expect('missing' in parsed).toBe(false);
    });
  });

  describe('maskMobile', () => {
    it('masks the middle of a phone number', () => {
      expect(maskMobile('09123456789')).toBe('0912****789');
    });

    it('returns null for empty input and *** for short strings', () => {
      expect(maskMobile(null)).toBeNull();
      expect(maskMobile('')).toBeNull();
      expect(maskMobile('123')).toBe('***');
    });
  });

  describe('sanitizeForLog', () => {
    it('truncates long strings and caps arrays', () => {
      const long = 'a'.repeat(5000);
      const result = sanitizeForLog({ body: long }) as { body: string };
      expect(result.body.length).toBeLessThan(1200);
      expect(result.body).toContain('[truncated');

      const many = Array.from({ length: 100 }, (_, i) => i);
      const arr = sanitizeForLog(many) as unknown[];
      expect(arr.length).toBe(51);
    });

    it('serializes errors inside structures', () => {
      const result = sanitizeForLog({ error: new Error('boom') }) as any;
      expect(result.error.message).toBe('boom');
      expect(result.error.type).toBe('Error');
    });
  });

  describe('serializeError', () => {
    it('captures axios status and response body without headers', () => {
      const error = new AxiosError('Request failed');
      (error as any).response = {
        status: 500,
        data: { meta: 'broken' },
        headers: { 'set-cookie': 'secret' },
      };
      (error as any).code = 'ERR_BAD_RESPONSE';

      const serialized = serializeError(error);

      expect(serialized.httpStatus).toBe(500);
      expect(serialized.httpResponseBody).toContain('broken');
      expect(serialized.type).toContain('ERR_BAD_RESPONSE');
      expect(JSON.stringify(serialized)).not.toContain('set-cookie');
    });

    it('handles non-Error values', () => {
      expect(serializeError('oops').message).toBe('oops');
      expect(serializeError(undefined).type).toBe('UnknownError');
    });
  });

  describe('truncateForLog', () => {
    it('keeps short strings intact', () => {
      expect(truncateForLog('hello')).toBe('hello');
    });
  });
});

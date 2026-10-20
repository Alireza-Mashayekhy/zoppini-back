import { BadRequestException } from '@nestjs/common';

import {
  addDaysToDateString,
  parseTehranDateRange,
  tehranStartOfDayUtc,
  todayInTehran,
} from './tehran-date.util';

describe('tehran-date.util', () => {
  it('builds UTC boundaries for a Tehran calendar day', () => {
    const range = parseTehranDateRange('2026-10-20', '2026-10-20');

    expect(range.fromUtc.toISOString()).toBe('2026-10-19T20:30:00.000Z');
    expect(range.toExclusiveUtc.toISOString()).toBe('2026-10-20T20:30:00.000Z');
  });

  it('keeps to inclusive by using the next Tehran midnight', () => {
    const range = parseTehranDateRange('2026-10-19', '2026-10-20');

    expect(range.fromUtc.toISOString()).toBe('2026-10-18T20:30:00.000Z');
    expect(range.toExclusiveUtc.toISOString()).toBe('2026-10-20T20:30:00.000Z');
  });

  it('computes today in Tehran across the UTC midnight boundary', () => {
    expect(todayInTehran(new Date('2026-10-20T20:29:59.000Z'))).toBe(
      '2026-10-20',
    );
    expect(todayInTehran(new Date('2026-10-20T20:30:00.000Z'))).toBe(
      '2026-10-21',
    );
  });

  it('handles calendar-day arithmetic', () => {
    expect(addDaysToDateString('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDaysToDateString('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('rejects invalid, reversed and too-wide ranges', () => {
    expect(() => parseTehranDateRange('2026-02-30', '2026-03-01')).toThrow(
      BadRequestException,
    );
    expect(() => parseTehranDateRange('2026-10-21', '2026-10-20')).toThrow(
      BadRequestException,
    );
    expect(() => parseTehranDateRange('2020-01-01', '2026-01-01')).toThrow(
      BadRequestException,
    );
    expect(() => parseTehranDateRange(undefined, '2026-01-01')).toThrow(
      BadRequestException,
    );
  });

  it('returns a UTC instant for Tehran midnight', () => {
    expect(tehranStartOfDayUtc('2026-10-20').toISOString()).toBe(
      '2026-10-19T20:30:00.000Z',
    );
  });
});

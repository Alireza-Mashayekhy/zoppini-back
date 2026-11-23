import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * نگهبان ثبت مایگریشن‌ها.
 *
 * مایگریشنی که فایلش هست ولی در فهرست `migrations` تایپ‌اورم ثبت نشده،
 * هیچ‌وقت اجرا نمی‌شود؛ در محیط توسعه `synchronize` جایش را پر می‌کند و
 * مشکل پنهان می‌ماند، ولی در production ستون‌ها ساخته نمی‌شوند و اولین
 * SELECT/INSERT روی آن جدول با «Unknown column» و خطای ۵۰۰ می‌شکند
 * (همین اتفاق برای `1807000000000-CartDiscountEligibility` افتاد).
 */
const CONFIGS = [
  '../common/config/typeorm.config.ts',
  '../common/config/typeorm-datasource.ts',
];

/**
 * فقط مایگریشن‌های قدیمیِ پیش از این محافظ. این یکی ALTER غیر idempotent
 * دارد (`MODIFY COLUMN ... NOT NULL`) و سال‌ها پیش به‌صورت دستی روی
 * production اعمال شده است؛ ثبت دوباره‌اش در بوت، ریسک بی‌دلیل دارد و به
 * این ماژول هم مربوط نیست. هر فایل تازه باید ثبت شود.
 */
const LEGACY_UNREGISTERED = [
  '1730970000000-ChangeCategoryDescriptionToLongtext',
];

function migrationNames(): string[] {
  return readdirSync(join(__dirname))
    .filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .map(file => file.replace(/\.ts$/, ''))
    .sort();
}

describe('migration registration', () => {
  it.each(CONFIGS)('%s registers every migration file on disk', config => {
    const source = readFileSync(join(__dirname, config), 'utf8');
    const unregistered = migrationNames().filter(
      name =>
        !LEGACY_UNREGISTERED.includes(name) &&
        !source.includes(`/migrations/${name}'`),
    );

    expect(unregistered).toEqual([]);
  });

  it.each(CONFIGS)('%s lists the same migrations in its array', config => {
    const source = readFileSync(join(__dirname, config), 'utf8');

    for (const name of migrationNames()) {
      if (LEGACY_UNREGISTERED.includes(name)) {
        continue;
      }

      const className = name.replace(/^\d+-/, '') + name.split('-')[0];

      expect(source).toContain(`${className},`);
    }
  });

  it('keeps the legacy exception list honest', () => {
    const names = migrationNames();

    for (const legacy of LEGACY_UNREGISTERED) {
      expect(names).toContain(legacy);
    }
  });
});

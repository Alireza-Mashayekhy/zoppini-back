/**
 * تستِ منطقِ خالصِ بازنویسی لینک‌های مقالات.
 *
 * اجرا (بدون نیاز به دیتابیس):
 *   cd back && pnpm test:scripts
 *
 * توجه: تنظیمات jest در `back/package.json` فقط `*.spec.ts` را اجرا می‌کند،
 * بنابراین این فایل توسط `pnpm test` اجرا نمی‌شود (تغییر testRegex نیازمند
 * تأیید جداگانه است)؛ `test:scripts` با همان ابزارِ موجود (`ts-node` و
 * اجراکننده‌ی تستِ خودِ Node) این فایل و هر `*.test.ts` دیگری را در
 * `src/scripts` اجرا می‌کند — بدون وابستگیِ جدید.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  rewriteBlogUrl,
  rewriteLinksInBlockItems,
  rewriteLinksInText,
} from './blog-link-rewrite';

const slugs = new Set(['best-suit-colors', 'shirt-size-guide']);

void test('an old absolute article URL is rewritten to /blog/{slug}', () => {
  assert.equal(
    rewriteBlogUrl('https://zoppinico.com/best-suit-colors/', slugs),
    '/blog/best-suit-colors',
  );
});

void test('www and http variants and a missing trailing slash are handled', () => {
  assert.equal(
    rewriteBlogUrl('http://www.zoppinico.com/best-suit-colors', slugs),
    '/blog/best-suit-colors',
  );
});

void test('query string and hash are preserved', () => {
  assert.equal(
    rewriteBlogUrl(
      'https://zoppinico.com/best-suit-colors/?ref=home#top',
      slugs,
    ),
    '/blog/best-suit-colors?ref=home#top',
  );
});

void test('unknown root slugs are never rewritten (no broad slug rewriting)', () => {
  assert.equal(rewriteBlogUrl('https://zoppinico.com/some-page/', slugs), null);
  assert.equal(rewriteBlogUrl('https://zoppinico.com/products/', slugs), null);
});

void test('paths that are not a single segment are left alone', () => {
  assert.equal(
    rewriteBlogUrl('https://zoppinico.com/blog/best-suit-colors/', slugs),
    null,
  );
  assert.equal(
    rewriteBlogUrl('https://zoppinico.com/best-suit-colors/extra/', slugs),
    null,
  );
});

void test('external domains are left alone', () => {
  assert.equal(
    rewriteBlogUrl('https://example.com/best-suit-colors/', slugs),
    null,
  );
});

void test('already-correct relative links are left alone', () => {
  const { value, changed } = rewriteLinksInText(
    '<a href="/blog/best-suit-colors">لینک</a>',
    slugs,
  );

  assert.equal(changed, false);
  assert.equal(value, '<a href="/blog/best-suit-colors">لینک</a>');
});

void test('links inside HTML are rewritten and a diff is collected', () => {
  const replacements = [];
  const { value, changed } = rewriteLinksInText(
    '<p>ببینید <a href="https://zoppinico.com/best-suit-colors/">اینجا</a></p>',
    slugs,
    replacements,
  );

  assert.equal(changed, true);
  assert.equal(
    value,
    '<p>ببینید <a href="/blog/best-suit-colors">اینجا</a></p>',
  );
  assert.deepEqual(replacements, [
    {
      before: 'https://zoppinico.com/best-suit-colors/',
      after: '/blog/best-suit-colors',
    },
  ]);
});

void test('trailing punctuation is not treated as part of the URL', () => {
  const { value } = rewriteLinksInText(
    'آدرس: https://zoppinico.com/shirt-size-guide/.',
    slugs,
  );

  assert.equal(value, 'آدرس: /blog/shirt-size-guide.');
});

void test('multiple links in one body are all rewritten', () => {
  const replacements = [];
  const { value } = rewriteLinksInText(
    '<a href="https://zoppinico.com/best-suit-colors/">۱</a>' +
      '<a href="https://zoppinico.com/shirt-size-guide/">۲</a>',
    slugs,
    replacements,
  );

  assert.equal(
    value,
    '<a href="/blog/best-suit-colors">۱</a><a href="/blog/shirt-size-guide">۲</a>',
  );
  assert.equal(replacements.length, 2);
});

void test('empty or missing text is a no-op', () => {
  assert.equal(rewriteLinksInText(null, slugs).changed, false);
  assert.equal(rewriteLinksInText('', slugs).changed, false);
});

void test('block items rewrite only link-bearing string fields', () => {
  const replacements = [];
  const { value, changed } = rewriteLinksInBlockItems(
    [
      { html: '<a href="https://zoppinico.com/best-suit-colors/">x</a>' },
      { linkUrl: 'https://zoppinico.com/shirt-size-guide/' },
      { url: 'https://zoppinico.com/uploads/video.mp4' },
      { caption: 'https://zoppinico.com/best-suit-colors/' },
    ],
    slugs,
    replacements,
  );

  assert.equal(changed, true);
  assert.equal(value?.[0].html, '<a href="/blog/best-suit-colors">x</a>');
  assert.equal(value?.[1].linkUrl, '/blog/shirt-size-guide');
  // آدرسِ مدیا تغییر نمی‌کند (اسلاگِ مقاله نیست).
  assert.equal(value?.[2].url, 'https://zoppinico.com/uploads/video.mp4');
  // فیلدهایی که لینک محسوب نمی‌شوند دست‌نخورده می‌مانند.
  assert.equal(value?.[3].caption, 'https://zoppinico.com/best-suit-colors/');
  assert.equal(replacements.length, 2);
});

void test('empty block item lists are a no-op', () => {
  assert.equal(rewriteLinksInBlockItems(null, slugs).changed, false);
  assert.equal(rewriteLinksInBlockItems([], slugs).changed, false);
});

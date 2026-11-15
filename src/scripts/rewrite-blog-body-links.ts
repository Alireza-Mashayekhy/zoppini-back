/**
 * بازنویسی لینک‌های قدیمیِ داخل متن مقالات وبلاگ.
 *
 * مسئله: در بعضی مقاله‌ها لینکِ داخلی به‌صورت آدرسِ کاملِ قدیمی
 * `https://zoppinico.com/{slug}/` ذخیره شده است. این الگوی آدرس در سایت فعلی
 * وجود ندارد (آدرسِ مقاله `/blog/{slug}` است) و در نتیجه این لینک‌های داخلی
 * شکسته یا وابسته به ریدایرکت‌اند. این اسکریپت آن‌ها را به آدرس نسبیِ درست
 * `/blog/{slug}` تبدیل می‌کند.
 *
 * محدوده‌ی عمدی (برای جلوگیری از بازنویسیِ گسترده — قوانین دقیق در
 * `./blog-link-rewrite.ts`):
 * - فقط اسلاگی بازنویسی می‌شود که **واقعاً متعلق به یک مقاله‌ی موجود** در جدول
 *   `blog_posts` باشد؛ بنابراین هیچ اسلاگِ روتِ دلخواهی تغییر نمی‌کند و هیچ
 *   ریدایرکتِ عمومی‌ای ایجاد نمی‌شود؛
 * - فقط آدرس‌های خودِ سایت (با/بدون www، http/https) بررسی می‌شوند؛
 * - فقط «مسیر تک‌بخشی» بازنویسی می‌شود؛ آدرس‌های عمیق‌تر دست‌نخورده می‌مانند تا
 *   بعداً به‌صورت موردی بررسی شوند؛
 * - query string و hash حفظ می‌شوند.
 *
 * حالت اجرا: **پیش‌فرض dry-run است و هیچ چیزی در پایگاه داده تغییر نمی‌کند.**
 * برای اعمال واقعی باید هم فلگ `--apply` و هم متغیر محیطی
 * `BLOG_LINK_REWRITE_APPLY=1` تنظیم شود:
 *
 *   BLOG_LINK_REWRITE_APPLY=1 pnpm migration:blog-links --apply
 *
 * خروجی شامل یک diff کاملِ قبل/بعد برای هر تغییر و یک خلاصه است.
 *
 * توجه: این اسکریپت هرگز اجرا نشده است (نه dry-run و نه apply)؛ اجرای آن
 * نیازمند تأیید جداگانه است.
 */

import { BlogBlock } from 'src/blog/entities/blog-block.entity';
import { BlogPost } from 'src/blog/entities/blog-post.entity';
import dataSource from 'src/common/config/typeorm-blog-links-datasource';

import {
  LinkReplacement,
  rewriteLinksInBlockItems,
  rewriteLinksInText,
} from './blog-link-rewrite';

const applyEnv = process.env.BLOG_LINK_REWRITE_APPLY === '1';
const applyFlag = process.argv.includes('--apply');
const apply = applyEnv && applyFlag;

interface ChangeReport {
  postId: number;
  postSlug: string;
  postTitle: string;
  target: string;
  replacements: LinkReplacement[];
}

async function main() {
  console.log(
    apply
      ? '⚠️  حالت APPLY: تغییرات در پایگاه داده اعمال خواهد شد.'
      : 'حالت DRY-RUN: هیچ تغییری در پایگاه داده اعمال نمی‌شود.',
  );

  await dataSource.initialize();

  try {
    const postRepo = dataSource.getRepository(BlogPost);
    const blockRepo = dataSource.getRepository(BlogBlock);

    const posts = await postRepo.find({
      select: { id: true, slug: true, title: true, content: true },
      order: { id: 'ASC' },
    });

    const slugs = new Set(posts.map(post => post.slug));

    console.log(`تعداد مقالات بررسی‌شده: ${posts.length}`);

    const changes: ChangeReport[] = [];

    for (const post of posts) {
      const replacements: LinkReplacement[] = [];
      const { value: content, changed } = rewriteLinksInText(
        post.content,
        slugs,
        replacements,
      );

      if (!changed) continue;

      changes.push({
        postId: post.id,
        postSlug: post.slug,
        postTitle: post.title,
        target: 'content',
        replacements: [...replacements],
      });

      if (apply) {
        await postRepo.update(post.id, { content });
      }
    }

    const blocks = await blockRepo.find({ order: { id: 'ASC' } });

    for (const block of blocks) {
      const replacements: LinkReplacement[] = [];
      const { value: items, changed } = rewriteLinksInBlockItems(
        block.items as unknown as Record<string, unknown>[] | null,
        slugs,
        replacements,
      );

      if (!changed) continue;

      const post = posts.find(item => item.id === block.postId);

      changes.push({
        postId: block.postId,
        postSlug: post?.slug ?? '(unknown)',
        postTitle: post?.title ?? '',
        target: `block:${block.id}`,
        replacements: [...replacements],
      });

      if (apply) {
        await blockRepo.update(block.id, {
          items: items,
        });
      }
    }

    const totalReplacements = changes.reduce(
      (sum, change) => sum + change.replacements.length,
      0,
    );

    console.log('');
    console.log('--- diff ---');

    if (!changes.length) {
      console.log('هیچ لینک قدیمی‌ای پیدا نشد؛ نیازی به تغییر نیست.');
    }

    for (const change of changes) {
      console.log('');
      console.log(
        `#${change.postId} /${change.postSlug} — ${change.postTitle} [${change.target}]`,
      );

      for (const replacement of change.replacements) {
        console.log(`  - ${replacement.before}`);
        console.log(`  + ${replacement.after}`);
      }
    }

    console.log('');
    console.log('--- خلاصه ---');
    console.log(`تعداد رکوردهای تغییریافته: ${changes.length}`);
    console.log(`تعداد لینک‌های بازنویسی‌شده: ${totalReplacements}`);
    console.log(
      apply
        ? 'تغییرات اعمال شد.'
        : 'این اجرا فقط نمایشی بود. برای اعمال: BLOG_LINK_REWRITE_APPLY=1 … --apply',
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('بازنویسی لینک‌های وبلاگ ناموفق بود:', error);
  process.exitCode = 1;
});

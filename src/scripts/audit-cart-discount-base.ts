import dataSource from 'src/common/config/typeorm-datasource';

/**
 * گزارش خواندنیِ (read-only) تنظیمات «تخفیف عمومی سبد».
 *
 * این اسکریپت هیچ نوشتنی در دیتابیس انجام نمی‌دهد؛ فقط نشان می‌دهد موتور
 * دقیقاً با چه مقادیری کار می‌کند و برای یک سبد نمونه، هر دو حالت چه عددی
 * می‌دهد. با آن می‌توان در یک نگاه فهمید اختلاف عددی سبد از تنظیمات است یا
 * از محاسبه.
 *
 *   pnpm run promotions:audit-base
 */

const SAMPLE_PRICE = 9_980_000;
const SAMPLE_PRODUCT_DISCOUNT = 50;

type Row = {
  id: number;
  name: string | null;
  isActive: number | boolean;
  applyToDiscountedProducts: number | boolean | null;
  cartDiscountBase: string | null;
  rewardType: string | null;
  rewardValue: string | number | null;
};

function workedExample(base: string | null, percent: number) {
  const afterProductDiscount =
    SAMPLE_PRICE * (1 - SAMPLE_PRODUCT_DISCOUNT / 100);
  const discount =
    base === 'original_price'
      ? (SAMPLE_PRICE * percent) / 100
      : (afterProductDiscount * percent) / 100;

  return {
    discount: Math.round(discount),
    final: Math.round(afterProductDiscount - discount),
  };
}

async function main() {
  await dataSource.initialize();

  try {
    const rows: Row[] = await dataSource.query(
      `SELECT id, name, isActive, applyToDiscountedProducts, cartDiscountBase,
              rewardType, rewardValue
         FROM promotions
        WHERE type = 'cart_discount'
        ORDER BY id`,
    );

    if (!rows.length) {
      console.log('هیچ پروموشن «تخفیف عمومی سبد» وجود ندارد.');
      return;
    }

    console.log('پروموشن‌های «تخفیف عمومی سبد» و مبنای محاسبهٔ ذخیره‌شده:\n');

    for (const row of rows) {
      const percent = Number(row.rewardValue ?? 0);
      const base = row.cartDiscountBase ?? 'discounted_price';
      const example = workedExample(
        base,
        row.rewardType === 'percentage' ? percent : 0,
      );

      console.log(`#${row.id} ${row.name ?? ''}`);
      console.log(
        `   فعال: ${row.isActive ? 'بله' : 'خیر'} | روی محصولات دارای تخفیف: ${
          row.applyToDiscountedProducts ? 'بله' : 'خیر'
        }`,
      );
      console.log(
        `   مبنای محاسبه: ${base} (${
          base === 'original_price' ? 'جمعی' : 'متوالی'
        }) | نوع: ${row.rewardType} | مقدار: ${row.rewardValue}`,
      );
      console.log(
        `   نمونه: قیمت ${SAMPLE_PRICE.toLocaleString()} با تخفیف محصول ` +
          `${SAMPLE_PRODUCT_DISCOUNT}٪ و تخفیف سبد ${percent}٪ → ` +
          `تخفیف سبد ${example.discount.toLocaleString()} تومان، ` +
          `پرداختی ${example.final.toLocaleString()} تومان`,
      );
      console.log('');
    }

    const additive = rows.filter(
      row => row.cartDiscountBase === 'original_price',
    );

    if (additive.length) {
      console.log(
        'توجه: این پروموشن‌ها روی «قیمت اصلی» حساب می‌کنند (حالت جمعی). ' +
          'اگر انتظار حالت متوالی (قیمت پس از تخفیف محصول) را دارید، ' +
          'همان مقدار را در پنل ادمین انتخاب و ذخیره کنید:',
      );

      for (const row of additive) {
        console.log(
          `   UPDATE promotions SET cartDiscountBase = 'discounted_price' WHERE id = ${row.id};`,
        );
      }
    } else {
      console.log(
        'همهٔ پروموشن‌های تخفیف سبد روی «قیمت پس از تخفیف محصول» حساب می‌کنند.',
      );
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('گزارش مبنای تخفیف سبد ناموفق بود:', error);
  process.exitCode = 1;
});

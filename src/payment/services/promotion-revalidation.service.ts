import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { OrderItem } from 'src/order/entities/order-item';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import { PromotionsService } from 'src/promotions/promotions.service';
import { Variant } from 'src/products/entities/variant.entity';
import { DataSource } from 'typeorm';

export interface PromotionRevalidationResult {
  ok: boolean;
  /** توضیح شفاف برای مشتری */
  message: string | null;
  /** آیا مبلغ یا شرایط سفارش تغییر کرده است */
  changed: boolean;
  changes: string[];
}

/**
 * اعتبارسنجی پروموشن‌ها پیش از پرداخت.
 *
 * چرا لازم است؟ قیمتی که مشتری در سبد دید ممکن است بین ساخت سفارش و پرداخت
 * تغییر کند (انقضا، پرشدن ظرفیت، ناموجود شدن هدیه، تغییر موجودی).
 * قانون: هرگز مبلغ بیشتر از آنچه تأیید شده از مشتری گرفته نمی‌شود؛ اگر
 * پروموشنی از بین برود، سفارش با قیمت جدید ساخته می‌شود و مشتری باید
 * دوباره آن را تأیید کند.
 */
@Injectable()
export class PromotionRevalidationService {
  private readonly logger = new Logger(PromotionRevalidationService.name);

  constructor(
    private readonly promotionsService: PromotionsService,
    private readonly dataSource: DataSource,
  ) {}

  async revalidateOrder(order: Order): Promise<PromotionRevalidationResult> {
    if (!order.promotionSnapshot?.length) {
      return { ok: true, message: null, changed: false, changes: [] };
    }

    const now = new Date();
    const changes: string[] = [];

    const items = order.items ?? [];

    for (const snapshot of order.promotionSnapshot) {
      const promotion = await this.promotionsService.findActiveById(
        snapshot.promotionId,
      );

      if (!promotion) {
        changes.push(
          `پیشنهاد «${snapshot.name}» دیگر فعال نیست و از این سفارش حذف شد.`,
        );

        continue;
      }

      if (new Date(promotion.expiresAt) < now) {
        changes.push(
          `مهلت پیشنهاد «${snapshot.name}» به پایان رسیده است و از سفارش حذف شد.`,
        );

        continue;
      }

      for (const variantId of snapshot.rewardVariantIds) {
        const variant = await this.dataSource.manager.findOne(Variant, {
          where: { id: variantId },
          relations: { product: true },
        });

        const orderedRewardQuantity = items
          .filter(
            item =>
              item.variantId === variantId &&
              (item.promotionRewardId === snapshot.promotionId ||
                item.isPromotionReward),
          )
          .reduce((sum, item) => sum + item.quantity, 0);

        if (!variant) {
          changes.push(
            `کالای هدیهٔ «${snapshot.name}» دیگر موجود نیست و از سفارش حذف شد.`,
          );

          continue;
        }

        if ((variant.stock ?? 0) < orderedRewardQuantity) {
          changes.push(
            `موجودی کالای هدیهٔ «${snapshot.name}» کافی نیست و از سفارش حذف شد.`,
          );
        }
      }
    }

    if (!changes.length) {
      return { ok: true, message: null, changed: false, changes };
    }

    this.logger.warn(
      `⚠️ سفارش ${order.id}: پروموشن‌ها تغییر کرده‌اند؛ ${changes.join(' | ')}`,
    );

    // سفارش با شرایط جدید بازسازی می‌شود تا مشتری با مبلغ درست تأیید کند
    await this.rebuildOrderPricing(order, changes.length > 0);

    return {
      ok: false,
      changed: true,
      message:
        'شرایط پیشنهاد تغییر کرده است؛ مبلغ سفارش به‌روز شد. لطفاً مبلغ جدید را ببینید و دوباره تأیید کنید.',
      changes,
    };
  }

  /**
   * بازمحاسبهٔ سفارش با حذف پروموشن‌هایی که دیگر معتبر نیستند.
   * فقط روی سفارش PENDING انجام می‌شود.
   *
   * فرمول قیمت نهایی باید دقیقاً با همان چیزی که هنگام ساخت سفارش استفاده شد
   * یکی باشد:
   *
   *   final = totalPrice − saleDiscount − promotionDiscount − discount + shipping
   *
   * اگر فقط `discount` کم شود، تمام تخفیف‌های دیگر (فروش ویژه، پروموشن و کد
   * تخفیف) از قیمت جدید حذف می‌شوند و مشتری مبلغی بسیار بیشتر از واقعیت
   * می‌بیند — همان چیزی که قانون «هرگز بیشتر از تأیید مشتری» منع می‌کند.
   */
  private async rebuildOrderPricing(order: Order, promotionInvalid: boolean) {
    if (order.status !== OrderStatus.PENDING) {
      return;
    }

    const items = order.items ?? [];

    let removedFreeValue = 0;
    let removedDiscount = 0;
    let touched = false;

    for (const item of items) {
      if (!item.isPromotionReward) {
        continue;
      }

      const snapshot = (order.promotionSnapshot ?? []).find(entry =>
        entry.rewardVariantIds.includes(item.variantId ?? -1),
      );

      if (!snapshot) {
        continue;
      }

      const promotion = await this.promotionsService.findActiveById(
        snapshot.promotionId,
      );

      const valid =
        promotion &&
        new Date(promotion.expiresAt) >= new Date() &&
        (await this.hasStock(item.variantId, item.quantity));

      if (!valid) {
        /*
         * ارزش هدیه در `promotionDiscount` ردیف نگه داشته می‌شود، نه در
         * `totalPrice` (که برای ردیف رایگان صفر است). پس هر دو مقدار حذف‌شده
         * از همین یک فیلد می‌آیند؛ استفاده از totalPrice باعث می‌شد ارزش
         * هدیه در فاکتور باقی بماند.
         */
        const giftValue = Number(item.promotionDiscount ?? 0);

        removedFreeValue += giftValue;
        removedDiscount += giftValue;

        item.isPromotionReward = false;
        item.promotionRewardId = null;
        item.promotionLabel = 'هدیه حذف شد (شرایط تغییر کرد)';
        item.promotionDiscount = 0;
        item.totalPrice = 0;
        item.price = 0;
        item.quantity = 0;

        touched = true;
      }
    }

    /*
     * پروموشن غیرمعتبر ممکن است تخفیف نقدی داشته باشد (با یا بدون ردیف
     * رایگان). در آن حالت هر نوع تخفیف پروموشن ساقط می‌شود، حتی اگر هیچ
     * ردیفی حذف نشده باشد؛ در غیر این صورت فاکتور تخفیفی را نشان می‌دهد که
     * مستند به هیچ قاعدهٔ معتبری نیست.
     */
    if (promotionInvalid) {
      removedDiscount = Number(order.promotionDiscount ?? 0);
      touched = true;
    }

    if (!touched) {
      return;
    }

    const orderTotal = Number(order.totalPrice ?? 0);
    const saleDiscount = Number(order.saleDiscount ?? 0);
    const codeDiscount = Number(order.discount ?? 0);
    const shipping = Number(order.shippingCost ?? 0);

    const nextPromotionDiscount = Math.max(
      0,
      Number(order.promotionDiscount ?? 0) - removedDiscount,
    );

    /*
     * هزینهٔ ارسال دست نمی‌خورد: اگر ارسال رایگان را از پروموشن گرفته بود،
     * با حذف پروموشن ارسال «رایگان» باقی نمی‌ماند ولی مبلغ جدید ارسال هم
     * ناگهانی اضافه نمی‌شود؛ چون مشتری آن را تأیید نکرده است. پرچم
     * promotionFreeShipping پاک می‌شود تا پشتیبانی بداند ارسال رایگان
     * دیگر مستند به پروموشن نیست.
     */
    const shippingCost = shipping;

    const finalPrice = Math.max(
      0,
      orderTotal - saleDiscount - nextPromotionDiscount - codeDiscount + shippingCost,
    );

    order.promotionDiscount = nextPromotionDiscount as never;
    order.promotionFreeItemValue = Math.max(
      0,
      Number(order.promotionFreeItemValue ?? 0) - removedFreeValue,
    ) as never;
    order.promotionFreeShipping =
      nextPromotionDiscount > 0 ? order.promotionFreeShipping : false;
    order.shippingCost = shippingCost as never;
    order.finalPrice = finalPrice as never;

    // اسنپ‌شات هم باید با واقعیت جدید بخواند؛ در غیر این صورت گزارش
    // پشتیبانی مبلغی را نشان می‌دهد که مشتری پرداخت نکرده است.
    order.promotionSnapshot = (order.promotionSnapshot ?? []).filter(
      entry =>
        !promotionInvalid ||
        items.some(
          item =>
            item.promotionRewardId === entry.promotionId ||
            (item.promotionIds ?? []).includes(entry.promotionId),
        ),
    );

    await this.dataSource.manager.save(Order, order);
    await this.dataSource.manager.save(OrderItem, items);
  }

  private async hasStock(variantId: number | null, quantity: number) {
    if (variantId == null) {
      return true;
    }

    const variant = await this.dataSource.manager.findOne(Variant, {
      where: { id: variantId },
    });

    return !!variant && (variant.stock ?? 0) >= quantity;
  }

  /** در شروع پرداخت: اگر سفارش دیگر معتبر نیست، خطای شفاف بده */
  async assertPayable(order: Order) {
    const result = await this.revalidateOrder(order);

    if (!result.ok) {
      throw new BadRequestException(result.message ?? 'شرایط سفارش تغییر کرده است.');
    }

    return result;
  }
}

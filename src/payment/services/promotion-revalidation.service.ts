import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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
    await this.rebuildOrderPricing(order);

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
   */
  private async rebuildOrderPricing(order: Order) {
    if (order.status !== OrderStatus.PENDING) {
      return;
    }

    const items = order.items ?? [];
    let removedValue = 0;

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
        removedValue += Number(item.totalPrice ?? 0);
        item.isPromotionReward = false;
        item.promotionRewardId = null;
        item.promotionLabel = 'هدیه حذف شد (شرایط تغییر کرد)';
        item.totalPrice = 0;
        item.price = 0;
        item.quantity = 0;
      }
    }

    if (removedValue <= 0) {
      return;
    }

    const orderTotal = Number(order.totalPrice ?? 0);
    const discount = Number(order.discount ?? 0);
    const shipping = Number(order.shippingCost ?? 0);

    const finalPrice = Math.max(0, orderTotal - discount + shipping);

    order.finalPrice = finalPrice as never;

    await this.dataSource.manager.save(Order, order);
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

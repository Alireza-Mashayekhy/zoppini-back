// src/orders/orders.service.ts
import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Address } from 'src/address/entities/address.entity';
import { AnalyticsService } from 'src/analytics/analytics.service';
import {
  BotEventsService,
  VariantStockChangeInput,
} from 'src/bot-reports/bot-events.service';
import { Cart } from 'src/cart/entities/cart.entity';
import { ClubService } from 'src/club/club.service';
import {
  createCorrelationId,
  serializeError,
  structuredLog,
} from 'src/common/logging/structured-logger';
import { applySearch, getPagination, QueryDto } from 'src/common/query';
import { DiscountService } from 'src/discounts/discounts.service';
import { Discount } from 'src/discounts/entities/discount.entity';
import { DiscountUsage } from 'src/discounts/entities/discount-code-usage.entity';
import { FirstPurchaseGiftService } from 'src/first-purchase-gift/first-purchase-gift.service';
import { calculateFirstPurchaseGiftDiscount } from 'src/first-purchase-gift/first-purchase-gift-pricing';
import { buildPromotionSnapshot } from 'src/order/checkout-pricing';
import {
  Payment,
  PaymentGateway,
  PaymentStatus,
} from 'src/payment/entities/payment.entity';
import { describeDigipayPurchase } from 'src/payment/utils/digipay-instrument.util';
import { Variant } from 'src/products/entities/variant.entity';
import { EMPTY_PROMOTION_RESULT } from 'src/promotions/engine/promotion-engine';
import { buildPricedPromotionCart } from 'src/promotions/promotion-cart.util';
import { PromotionsService } from 'src/promotions/promotions.service';
import { RahkaranInvoiceSync } from 'src/rahkaran/entities/rahkaran-invoice-sync.entity';
import { RahkaranService } from 'src/rahkaran/rahkaran.service';
import { RahkaranInvoiceSyncService } from 'src/rahkaran/rahkaran-invoice-sync.service';
import {
  RahkaranStockService,
  STOCK_ERROR_CODES,
  StockCheckStage,
  unavailableMessage,
} from 'src/rahkaran/rahkaran-stock.service';
import { SmsService } from 'src/sms/sms.service';
import {
  TOROB_CLICK_WINDOW_MS,
  TorobAttribution,
} from 'src/torob/torob-attribution.util';
import { User } from 'src/users/entities/user.entity';
import { WalletService } from 'src/wallet/wallet.service';
import { DataSource, In, Repository } from 'typeorm';

import { CreateOrderDto, ShippingMethod } from './dto/create-order.dto';
import { Order, OrderStatus } from './entities/order.entity';
import { OrderItem } from './entities/order-item';
import { summarizeOrderStatusCounts } from './order-status-summary';
import { getShippingCostToman } from './shipping';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,

    @InjectRepository(Address)
    private readonly addressRepo: Repository<Address>,

    @InjectRepository(Cart)
    private readonly cartRepo: Repository<Cart>,

    @InjectRepository(Discount)
    private readonly discountRepo: Repository<Discount>,

    @InjectRepository(DiscountUsage)
    private readonly discountUsageRepo: Repository<DiscountUsage>,

    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,

    private readonly rahkaranService: RahkaranService,

    private readonly clubService: ClubService,

    private readonly discountService: DiscountService,

    private readonly smsService: SmsService,

    private readonly walletService: WalletService,

    private readonly dataSource: DataSource,
    private readonly analyticsService: AnalyticsService,

    @Optional()
    private readonly botEventsService?: BotEventsService,

    /**
     * سرویس پروموشن؛ اختیاری است تا سازندهٔ موجود (و تست‌های قبلی) نشکند.
     * در اپ واقعی همیشه با DI تزریق می‌شود و همهٔ مسیرهای قیمت‌گذاری از آن
     * استفاده می‌کنند.
     */
    @Optional()
    private readonly promotionsService?: PromotionsService,

    @Optional()
    private readonly firstPurchaseGiftService?: FirstPurchaseGiftService,

    /**
     * ردیابی + retry ثبت فاکتور راهکاران؛ اختیاری است تا سازندهٔ
     * موجود و تست‌های قبلی نشکنند. در اپ واقعی همیشه با DI تزریق می‌شود.
     */
    @Optional()
    @Inject(forwardRef(() => RahkaranInvoiceSyncService))
    private readonly rahkaranInvoiceSyncService?: RahkaranInvoiceSyncService,

    /**
     * بررسی لحظه‌ای موجودی از راهکاران پیش از ثبت/تأیید سفارش.
     *
     * دکوریتور @Optional ندارد، پس در اپ واقعی DI آن را الزامی می‌داند و
     * بدون آن اپ بالا نمی‌آید. اگر در ساخت دستی (تست) داده نشود، مسیرهای
     * خرید «Fail closed» می‌شوند (نگاه کنید به assertStockForPurchase).
     */
    @Inject(forwardRef(() => RahkaranStockService))
    private readonly rahkaranStockService?: RahkaranStockService,
  ) {}

  /**
   * بررسی موجودی همهٔ اقلام از راهکاران (و به‌روزرسانی موجودی سایت).
   * ناکافی → 409 با فهرست اقلام؛ عدم دسترسی → 503.
   */
  private async assertStockForPurchase(
    items: Array<{ quantity: number; variant?: { id: number } | null }>,
    stage: StockCheckStage,
    userId: number,
    orderId?: number,
  ): Promise<void> {
    if (!this.rahkaranStockService) {
      this.logger.error(
        structuredLog('stock.check.service_missing', { stage, orderId }),
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: STOCK_ERROR_CODES.UNAVAILABLE,
        message: unavailableMessage(stage),
      });
    }

    await this.rahkaranStockService.assertCheckoutStock(
      items
        .filter(item => item.variant?.id)
        .map(item => ({
          variantId: item.variant!.id,
          quantity: Number(item.quantity),
        })),
      { stage, excludeUserId: userId, orderId },
    );
  }

  // تولید شماره سفارش منحصربه‌فرد
  private generateOrderNumber(): string {
    const prefix = 'ORD';
    const timestamp = Date.now().toString().slice(-8);
    const random = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, '0');
    return `${prefix}-${timestamp}-${random}`;
  }

  async createOrder(
    userId: number,
    dto: CreateOrderDto,
    attribution: TorobAttribution | null = null,
    analyticsContext = '',
  ) {
    // =====================================================
    // 1. User
    // =====================================================

    const user = await this.userRepo.findOne({
      where: {
        id: userId,
      },
    });

    if (!user) {
      throw new NotFoundException('کاربر یافت نشد.');
    }

    // =====================================================
    // 2. Address
    // =====================================================

    // Pickup does not require a delivery address. If one is supplied, still
    // check ownership; never attach another customer's address.
    let address: Address | null = null;
    if (dto.addressId !== undefined) {
      address = await this.addressRepo.findOne({
        where: { id: dto.addressId, user: { id: userId } },
      });
      if (!address)
        throw new BadRequestException('آدرس انتخاب‌شده معتبر نیست.');
    } else if (dto.shippingMethod !== ShippingMethod.PICKUP) {
      throw new BadRequestException('آدرس انتخاب‌شده معتبر نیست.');
    }

    // =====================================================
    // 3. Cart
    // =====================================================

    const cart = await this.cartRepo.findOne({
      where: {
        user: {
          id: userId,
        },
      },
      relations: {
        items: {
          variant: {
            product: {
              categories: true,
            },
          },
        },
      },
    });

    if (!cart || !cart.items?.length) {
      throw new BadRequestException('سبد خرید خالی است.');
    }

    // =====================================================
    // 3-b. بررسی دوبارهٔ موجودی همهٔ اقلام از راهکاران
    // =====================================================

    /*
     * پیش از ساخت سفارش: اگر یک یا چند قلم کافی نباشد سفارشی ساخته
     * نمی‌شود و فهرست «کالا / تنوع / تعداد موجود» برمی‌گردد تا مشتری
     * سبدش را اصلاح کند. راهکاران در دسترس نباشد → 503 (سفارش ثبت نمی‌شود).
     */
    await this.assertStockForPurchase(cart.items, 'checkout', userId);

    // =====================================================
    // 4. محاسبه قیمت محصولات
    // =====================================================

    const pricedLines = await this.discountService.priceCartLines(
      cart.items.map(item => ({
        productId: item.variant.product.id,
        quantity: item.quantity,
        price: Number(item.variant.price),
        categoryIds:
          item.variant.product.categories?.map(category => category.id) ?? [],
      })),
    );

    // =====================================================
    // 4-b. پروموشن‌ها (قبل از محاسبه ارسال و کد تخفیف)
    // =====================================================

    /*
     * سبد «قیمت‌گذاری‌شده» به موتور داده می‌شود تا با چیزی که مشتری در سبد
     * دیده یکی باشد: قیمت پس از فروش ویژه + قیمت فهرست برای مبنای
     * «original_price». ردیف‌های pricedLines و cart.items هم‌ردیف‌اند.
     */
    const promotionCart = buildPricedPromotionCart(
      cart,
      cart.items.map((item, index) => {
        const line = pricedLines[index];

        return {
          item,
          originalPrice: line?.originalPrice ?? Number(item.variant.price),
          unitPrice: line?.unitPrice ?? Number(item.variant.price),
        };
      }),
    );

    const promotionResult = this.promotionsService
      ? await this.promotionsService.evaluateCart({
          cart: promotionCart,
          userId,
          forCheckout: true,
        })
      : EMPTY_PROMOTION_RESULT;

    if (promotionResult.notices.length) {
      this.logger.log(
        `پروموشن‌های اعمال‌نشده در سفارش کاربر ${userId}: ${promotionResult.notices.join(' | ')}`,
      );
    }

    const promotionDiscountByLine = new Map<
      number,
      {
        amount: number;
        isFree: boolean;
        labels: string[];
        promotionIds: number[];
      }
    >();

    for (const evaluation of promotionResult.applied) {
      for (const allocation of evaluation.allocations) {
        const lineId = Number(allocation.lineId);

        if (!Number.isFinite(lineId)) {
          continue;
        }

        const current = promotionDiscountByLine.get(lineId) ?? {
          amount: 0,
          isFree: false,
          labels: [],
          promotionIds: [],
        };

        current.amount += allocation.isFree ? 0 : allocation.amount;
        current.isFree = current.isFree || allocation.isFree;

        if (!current.labels.includes(allocation.label)) {
          current.labels.push(allocation.label);
        }

        if (!current.promotionIds.includes(evaluation.promotionId)) {
          current.promotionIds.push(evaluation.promotionId);
        }

        promotionDiscountByLine.set(lineId, current);
      }
    }

    // هر کالای هدیه حتماً رایگان محاسبه شود (حتی اگر پروموشن در این لحظه
    // کامل احراز نشود، ردیف هدیه نباید پول بگیرد)
    for (const item of cart.items) {
      if (item.promotionRewardId != null) {
        const current = promotionDiscountByLine.get(item.id) ?? {
          amount: 0,
          isFree: false,
          labels: [],
          promotionIds: [],
        };

        current.isFree = true;
        current.promotionIds = [
          ...new Set([...current.promotionIds, item.promotionRewardId]),
        ];
        current.labels = ['رایگان (هدیه پروموشن)'];
        promotionDiscountByLine.set(item.id, current);
      }
    }

    let totalPrice = 0;

    let saleDiscountAmount = 0;

    let promotionDiscountAmount = 0;

    const orderItems = cart.items.map((item, index) => {
      const line = pricedLines[index];
      const promotionLine = promotionDiscountByLine.get(item.id);

      // قیمت فریزشدهٔ هر واحد = قیمت پس از فروش ویژه
      const salePrice = line.unitPrice;

      const lineSaleTotal = salePrice * item.quantity;
      const linePromotionDiscount = promotionLine?.isFree
        ? lineSaleTotal
        : Math.min(promotionLine?.amount ?? 0, lineSaleTotal);

      const itemTotal = Math.max(0, lineSaleTotal - linePromotionDiscount);

      totalPrice += line.originalPrice * item.quantity;

      saleDiscountAmount += line.saleDiscountPerUnit * item.quantity;

      promotionDiscountAmount += linePromotionDiscount;

      return {
        variant: item.variant,
        quantity: item.quantity,
        // قیمت فریزشدهٔ هر واحد = قیمت پس از فروش ویژه و پروموشن
        price:
          item.quantity > 0 ? Math.round(itemTotal / item.quantity) : salePrice,
        originalPrice: line.originalPrice,
        totalPrice: itemTotal,
        // تخفیف سطح محصول (فروش ویژه) روی این ردیف — برای فاکتور/پشتیبانی
        saleDiscount: line.saleDiscountPerUnit * item.quantity,
        promotionDiscount: linePromotionDiscount,
        isPromotionReward: !!item.promotionRewardId || !!promotionLine?.isFree,
        promotionRewardId: item.promotionRewardId ?? null,
        promotionLabel: promotionLine?.labels.join('، ') ?? null,
        promotionIds: promotionLine?.promotionIds ?? null,
      };
    });

    // =====================================================
    // 5. هزینه ارسال
    // =====================================================

    const promotionFreeShipping = promotionResult.freeShipping;

    const shippingCost = promotionFreeShipping
      ? 0
      : this.calculateShippingCost(dto.shippingMethod);

    // =====================================================
    // 6. تخفیف
    // =====================================================

    let codeDiscountAmount = 0;
    let discountId: number | null = null;
    let discountCode: string | null = null;

    if (dto.discountCode?.trim()) {
      const result = await this.discountService.validateDiscount(
        dto.discountCode.trim(),
        userId,
        pricedLines.map(line => ({
          productId: line.productId,
          quantity: line.quantity,
          price: line.unitPrice,
          categoryIds: line.categoryIds,
          isOnSale: line.isOnSale,
        })),
      );

      codeDiscountAmount = Number(result.discountAmount);

      discountId = result.discount.id;

      discountCode = result.discount.code;
    }

    let firstPurchaseGiftDiscount = 0;
    let firstPurchaseGiftPercent = 0;
    let firstPurchaseGiftStackWithDiscountCodes = false;
    let firstPurchaseGiftStackWithSalePrices = false;
    const firstPurchaseGiftEligibleItemIndexes: number[] = [];

    if (dto.useFirstPurchaseGift) {
      if (!this.firstPurchaseGiftService) {
        throw new BadRequestException('هدیهٔ اولین خرید در دسترس نیست.');
      }

      const gift =
        await this.firstPurchaseGiftService.getDiscountConfigForUser(userId);
      if (!gift.eligible) {
        throw new BadRequestException(
          gift.reason === 'inactive'
            ? 'هدیهٔ اولین خرید در حال حاضر فعال نیست.'
            : 'این حساب شرایط استفاده از هدیهٔ اولین خرید آنلاین را ندارد.',
        );
      }
      if (discountCode && !gift.settings.stackWithDiscountCodes) {
        throw new BadRequestException(
          'هدیهٔ اولین خرید با کد تخفیف قابل استفاده همزمان نیست؛ یکی از دو گزینه را انتخاب کنید.',
        );
      }

      firstPurchaseGiftPercent = Number(gift.settings.discountPercent);
      firstPurchaseGiftStackWithDiscountCodes =
        gift.settings.stackWithDiscountCodes;
      firstPurchaseGiftStackWithSalePrices = gift.settings.stackWithSalePrices;
      let eligibleProductSubtotal = 0;
      cart.items.forEach((item, index) => {
        const line = pricedLines[index];
        const promo = promotionDiscountByLine.get(item.id);
        const hasOtherPromotion =
          Boolean(item.promotionRewardId) ||
          Boolean(promo?.isFree) ||
          Number(promo?.amount ?? 0) > 0;
        if (
          (line.isOnSale && !gift.settings.stackWithSalePrices) ||
          hasOtherPromotion
        ) {
          return;
        }

        const lineSubtotal = Math.max(
          0,
          Number(line.unitPrice) * item.quantity,
        );
        if (lineSubtotal <= 0) return;
        eligibleProductSubtotal += lineSubtotal;
        firstPurchaseGiftEligibleItemIndexes.push(index);
      });

      if (eligibleProductSubtotal <= 0) {
        throw new BadRequestException(
          'سبد خرید محصولی با قیمت عادی برای استفاده از هدیهٔ اولین خرید ندارد.',
        );
      }

      firstPurchaseGiftDiscount = calculateFirstPurchaseGiftDiscount(
        eligibleProductSubtotal,
        firstPurchaseGiftPercent,
      );

      // پخش مبلغ هدیه روی همهٔ ردیف‌های واجد شرایط (نه یک محصول خاص).
      let remainingGiftDiscount = firstPurchaseGiftDiscount;
      firstPurchaseGiftEligibleItemIndexes.forEach((index, position) => {
        const item = orderItems[index];
        const isLast =
          position === firstPurchaseGiftEligibleItemIndexes.length - 1;
        const share = isLast
          ? remainingGiftDiscount
          : Math.min(
              remainingGiftDiscount,
              Math.round(
                (firstPurchaseGiftDiscount * Number(item.totalPrice)) /
                  eligibleProductSubtotal,
              ),
            );
        const appliedShare = Math.min(share, Number(item.totalPrice));
        item.totalPrice = Math.max(0, Number(item.totalPrice) - appliedShare);
        item.price =
          item.quantity > 0
            ? Math.round(item.totalPrice / item.quantity)
            : item.price;
        remainingGiftDiscount -= appliedShare;
      });
    }

    const discountAmount =
      saleDiscountAmount +
      promotionDiscountAmount +
      codeDiscountAmount +
      firstPurchaseGiftDiscount;

    // =====================================================
    // 7. مبلغ نهایی
    // =====================================================

    const finalPrice = Math.max(
      0,
      totalPrice + Number(shippingCost) - discountAmount,
    );

    // بررسی سازگاری: جمع ردیف‌ها باید دقیقاً با مبلغ نهایی بخواند
    const linesTotal = orderItems.reduce(
      (sum, item) => sum + Number(item.totalPrice),
      0,
    );
    const expectedLinesTotal = Math.max(
      0,
      totalPrice -
        saleDiscountAmount -
        promotionDiscountAmount -
        codeDiscountAmount -
        firstPurchaseGiftDiscount,
    );

    if (Math.abs(linesTotal - expectedLinesTotal) >= 1) {
      this.logger.error(
        `❌ ناسازگاری جمع ردیف‌ها با مبلغ سفارش: lines=${linesTotal} expected=${expectedLinesTotal}`,
      );

      const diff = linesTotal - expectedLinesTotal;

      if (diff > 0) {
        // ردیف‌ها بیشتر از انتظار: تخفیف روی آخرین ردیف اعمال شود
        for (
          let index = orderItems.length - 1;
          index >= 0 && diff > 0;
          index -= 1
        ) {
          const item = orderItems[index];
          const reduceBy = Math.min(diff, Number(item.totalPrice));

          item.totalPrice -= reduceBy;
          item.price =
            item.quantity > 0
              ? Math.round(item.totalPrice / item.quantity)
              : item.price;
        }
      }
    }

    let walletPayment = 0;
    let clubCreditPayment = 0;

    if (dto.useWallet) {
      const balance = await this.walletService.getBalance(userId);
      walletPayment = Math.min(balance, finalPrice);
    }

    if (dto.useClubCredit && finalPrice > walletPayment) {
      if (!user.phone) {
        throw new BadRequestException(
          'برای استفاده از اعتبار باشگاه، شماره موبایل حساب کاربری لازم است.',
        );
      }

      const customer = await this.clubService.getCustomer(user.phone);
      const availableCreditToman = Math.floor(
        Math.max(0, Number(customer.AvailableCredit ?? 0)) / 10,
      );
      clubCreditPayment = Math.min(
        availableCreditToman,
        finalPrice - walletPayment,
      );
    }

    // =====================================================
    // 8. ساخت Order
    // =====================================================

    const order = this.orderRepo.create({
      orderNumber: this.generateOrderNumber(),

      user,

      items: orderItems,

      totalPrice,

      shippingCost: Number(shippingCost),

      discount: discountAmount,

      saleDiscount: saleDiscountAmount,

      promotionDiscount: promotionDiscountAmount,

      firstPurchaseGiftDiscount,

      promotionFreeItemValue: promotionResult.totalFreeItemValue,

      promotionFreeShipping,

      promotionSnapshot: buildPromotionSnapshot(
        promotionResult.applied,
        new Map(
          cart.items.map(item => [String(item.id), item.variant?.id ?? null]),
        ),
      ),

      finalPrice,

      walletPayment,

      clubCreditPayment,

      discountId,

      discountCode,

      addressId: address?.id ?? null,

      address,

      note: dto.note ?? null,

      shippingMethod: dto.shippingMethod,

      status: OrderStatus.PENDING,
    });

    // =====================================================
    // 9. ذخیره سفارش + ثبت اتمیک رویداد Outbox در یک تراکنش
    // =====================================================

    const savedOrder = await this.dataSource.transaction(async manager => {
      // Lock the consent grant in the same transaction as the order attribution.
      // A concurrent revocation either wins first or removes the saved attribution.
      let allowed = false;
      if (
        attribution &&
        Date.now() - attribution.clickedAt < TOROB_CLICK_WINDOW_MS
      ) {
        const grants = await manager.query(
          'SELECT id FROM torob_attribution_grants WHERE id = ? AND active = 1 AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE',
          [attribution.grantId],
        );
        allowed = grants.length > 0;
      }
      const persisted = await manager.save(Order, order);
      const persistedItems = await manager.count(OrderItem, {
        where: { order: { id: persisted.id } },
      });
      if (persistedItems !== orderItems.length) {
        throw new Error(
          'Order items were not persisted; the order transaction has been rolled back',
        );
      }
      if (allowed && attribution) {
        await manager.update(Order, persisted.id, {
          torobClid: attribution.clid,
          torobGrantId: attribution.grantId,
        });
      }
      if (firstPurchaseGiftDiscount > 0) {
        await this.firstPurchaseGiftService?.reserveInTransaction(
          manager,
          userId,
          persisted.id,
          firstPurchaseGiftPercent,
          firstPurchaseGiftDiscount,
          {
            stackWithDiscountCodes: firstPurchaseGiftStackWithDiscountCodes,
            stackWithSalePrices: firstPurchaseGiftStackWithSalePrices,
            usedDiscountCode: Boolean(discountCode),
          },
        );
      }
      await this.botEventsService?.recordOrderCreatedInTransaction(
        manager,
        persisted,
      );
      return persisted;
    });

    // =====================================================
    // 10. سبد خرید فعلاً پاک نمی‌شود
    // =====================================================

    // این کار باید بعد از پرداخت موفق انجام شود.
    //
    // await this.cartService.clearCart(userId);

    if (analyticsContext) {
      try {
        await this.analyticsService.checkout(
          savedOrder.id,
          userId,
          analyticsContext,
        );
      } catch {
        this.logger.warn('Analytics checkout context could not be stored');
      }
    }
    if (walletPayment + clubCreditPayment >= finalPrice && finalPrice > 0) {
      try {
        return await this.confirmOrderPayment(savedOrder.id);
      } catch (error) {
        // مثلاً موجودی محصول کافی نبود؛ سفارش PENDING باقی می‌ماند و
        // کاربر می‌تواند با POST /orders/:id/confirm-from-wallet تلاش کند.
        this.logger.error(
          `❌ تأیید فوری سفارش ${savedOrder.id} با کیف پول خطا خورد: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return savedOrder;
  }

  async confirmOrderPayment(orderId: number): Promise<Order> {
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const order = await queryRunner.manager.findOne(Order, {
        where: { id: orderId },
        relations: {
          user: true,
          items: {
            variant: {
              product: true,
              color: true,
              size: true,
            },
          },
        },
      });

      if (!order) {
        throw new NotFoundException('سفارش یافت نشد');
      }

      // بسیار مهم برای callback تکراری
      if (order.status !== OrderStatus.PENDING) {
        throw new BadRequestException('فقط سفارشات در انتظار قابل تأیید هستند');
      }

      const userId = order.user.id;
      // Serialize every successful payment for this account so a simultaneous
      // ordinary checkout cannot race a first-purchase gift redemption.
      await queryRunner.manager.findOne(User, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });

      const walletPayment = Number(order.walletPayment ?? 0);

      if (walletPayment > 0) {
        await this.walletService.debitWallet(userId, walletPayment, {
          transactionKey: `wallet-order-${orderId}`,
          description: `پرداخت سفارش ${order.orderNumber}`,
          meta: { orderId, orderNumber: order.orderNumber },
        });
      }

      // =========================================================
      // 1. کاهش موجودی
      // =========================================================

      const stockChanges: VariantStockChangeInput[] = [];

      /*
       * ترتیب ثابت (بر اساس id واریانت) تا با به‌روزرسانی موجودی از راهکاران
       * (RahkaranStockService که ردیف‌ها را به همین ترتیب قفل می‌کند) یا
       * پرداخت هم‌زمان دیگر بن‌بست (deadlock) رخ ندهد.
       */
      const stockItems = [...order.items]
        .filter(item => item.variant)
        .sort((a, b) => a.variant!.id - b.variant!.id);

      for (const item of stockItems) {
        if (!item.variant) {
          continue;
        }

        const variant = await queryRunner.manager.findOne(Variant, {
          where: {
            id: item.variant.id,
          },
          relations: {
            product: true,
            color: true,
            size: true,
          },
        });

        if (!variant) {
          throw new NotFoundException(`واریانت ${item.variant.id} یافت نشد`);
        }

        if (variant.stock < item.quantity) {
          throw new BadRequestException(
            `موجودی کافی نیست برای ${variant.product?.title || 'محصول'}`,
          );
        }

        const oldStock = Number(variant.stock) || 0;
        const newStock = oldStock - Number(item.quantity);
        const variantParts = [variant.color?.name, variant.size?.name]
          .map(v => String(v ?? '').trim())
          .filter(Boolean);

        stockChanges.push({
          variantId: variant.id,
          productTitle: variant.product?.title || `محصول ${variant.productId}`,
          variantLabel: variantParts.length ? variantParts.join(' / ') : null,
          sku: variant.sku ?? null,
          oldStock,
          newStock,
        });

        /*
         * کسر اتمیک و شرطی: دو پرداخت هم‌زمانِ آخرین واحد هر دو از بررسی
         * بالا (خواندن بدون قفل) رد می‌شدند و موجودی منفی می‌شد. شرط
         * `stock >= quantity` در خود UPDATE این رقابت را می‌بندد.
         */
        const quantity = Number(item.quantity);
        const decrement = await queryRunner.manager
          .createQueryBuilder()
          .update(Variant)
          .set({ stock: () => `stock - ${quantity}` })
          .where('id = :id AND stock >= :quantity', {
            id: variant.id,
            quantity,
          })
          .execute();

        if (!decrement.affected) {
          throw new BadRequestException(
            `موجودی کافی نیست برای ${variant.product?.title || 'محصول'}`,
          );
        }
      }

      // =========================================================
      // 2. ثبت مصرف کد تخفیف
      // =========================================================

      if (order.discountCode || order.discountId) {
        await this.discountService.redeemInTransaction(queryRunner.manager, {
          discountId: order.discountId,
          code: order.discountCode,
          userId,
          orderId: order.id,
        });
      }

      // =========================================================
      // 2-b. ثبت استفاده از پروموشن‌ها (برای محدودیت استفاده و گزارش)
      // =========================================================

      if (this.promotionsService && order.promotionSnapshot?.length) {
        await this.promotionsService.recordRedemption(queryRunner.manager, {
          promotionIds: order.promotionSnapshot.map(snapshot => ({
            id: snapshot.promotionId,
            discountAmount: Number(snapshot.discountAmount ?? 0),
          })),
          orderId: order.id,
          userId,
        });
      }

      if (Number(order.firstPurchaseGiftDiscount ?? 0) > 0) {
        if (!this.firstPurchaseGiftService || !order.user) {
          throw new BadRequestException(
            'هدیهٔ خرید اول برای این سفارش قابل ثبت نیست.',
          );
        }
        await this.firstPurchaseGiftService.redeemInTransaction(
          queryRunner.manager,
          userId,
          order,
        );
      }
      await this.firstPurchaseGiftService?.releaseOtherReservationsForPaidOrder(
        queryRunner.manager,
        userId,
        order.id,
      );

      // =========================================================
      // 3. خالی کردن سبد خرید
      // =========================================================

      const cart = await queryRunner.manager.findOne(Cart, {
        where: {
          user: {
            id: userId,
          },
        },
      });

      if (cart) {
        await queryRunner.manager.delete('cart_item', {
          cart: {
            id: cart.id,
          },
        });
      }

      // =========================================================
      // 4. تغییر وضعیت سفارش + ثبت رویداد Outbox پرداخت و موجودی
      // =========================================================

      order.status = OrderStatus.PAID;
      order.torobWasPaid = true;

      await queryRunner.manager.save(Order, order);
      await this.analyticsService.purchase(queryRunner.manager, order.id);

      await this.botEventsService?.recordOrderPaidInTransaction(
        queryRunner.manager,
        order,
      );
      await this.botEventsService?.evaluateVariantStockTransitions(
        stockChanges,
        queryRunner.manager,
      );

      // =========================================================
      // 5. Commit
      // =========================================================

      await queryRunner.commitTransaction();

      // =========================================================
      // 6. ثبت فاکتور فروش در راهکاران
      // =========================================================

      const rahkaranCorrelationId = createCorrelationId('rah-inv');

      try {
        if (this.rahkaranInvoiceSyncService) {
          /**
           * مسیر اصلی: ثبت ردیابی‌شده.
           *
           * وضعیت هر تلاش در جدول `rahkaran_invoice_sync` ثبت می‌شود و در
           * صورت شکست، scheduler هر چند دقیقه retry می‌کند تا فاکتور
           * گمشده‌ای در راهکاران باقی نماند. این متد throw نمی‌کند و
           * سفارش سایت PAID باقی می‌ماند.
           */
          await this.rahkaranInvoiceSyncService.syncPaidOrder(
            await this.findOne(order.id),
            {
              trigger: 'payment',
              correlationId: rahkaranCorrelationId,
            },
          );
        } else {
          // Fallback برای سازندهٔ دستی/تست‌ها (بدون ردیابی دیتابیسی)
          const rahkaranInvoice =
            await this.rahkaranService.syncOrderToRahkaran(
              await this.findOne(order.id),
              { correlationId: rahkaranCorrelationId },
            );

          this.logger.log(
            structuredLog('rahkaran.invoice.registration.success', {
              correlationId: rahkaranCorrelationId,
              orderId: order.id,
              orderNumber: order.orderNumber,
              trigger: 'payment',
              tracked: false,
              invoiceId:
                rahkaranInvoice?.id ?? rahkaranInvoice?.invoiceId ?? null,
              invoiceNumber: rahkaranInvoice?.number ?? null,
            }),
          );
        }
      } catch (error) {
        this.logger.error(
          structuredLog('rahkaran.invoice.registration.failed', {
            correlationId: rahkaranCorrelationId,
            orderId: order.id,
            orderNumber: order.orderNumber,
            trigger: 'payment',
            error: serializeError(error),
          }),
        );

        // سفارش سایت PAID باقی می‌ماند؛ چون تراکنش دیتابیس سایت قبلاً
        // commit شده و rollback ممکن نیست. مسیر اصلی (syncPaidOrder) خطا
        // را می‌بلعد و در جدول ردیابی ثبت می‌کند تا retry خودکار انجام شود.
      }

      // =========================================================
      // 7. ثبت فاکتور فروش در باشگاه دایاتک
      // =========================================================

      const diatechCorrelationId = createCorrelationId('diatech-inv');

      let diatechInvoiceId: number | undefined;

      try {
        const invoice = await this.clubService.createInvoice(
          {
            customerCode: order.user.phone,
            finalPrice: order.finalPrice,
            currentCredit: Number(order.clubCreditPayment ?? 0),
          },
          { correlationId: diatechCorrelationId, orderId: order.id },
        );

        diatechInvoiceId = invoice?.Id;

        if (!invoice?.Id) {
          throw new Error('شناسه فاکتور دایاتک دریافت نشد.');
        }
        // تایید فاکتور باعث ثبت فروش و اعمال CurrentCredit مصرف‌شده در دایاتک می‌شود.
        await this.clubService.approveInvoice(invoice.Id, {
          correlationId: diatechCorrelationId,
          orderId: order.id,
        });

        this.logger.log(
          structuredLog('diatech.invoice.registration.success', {
            correlationId: diatechCorrelationId,
            orderId: order.id,
            orderNumber: order.orderNumber,
            invoiceId: invoice.Id,
          }),
        );
      } catch (error) {
        this.logger.error(
          structuredLog('diatech.invoice.registration.failed', {
            correlationId: diatechCorrelationId,
            orderId: order.id,
            orderNumber: order.orderNumber,
            // اگر invoiceId داریم یعنی create موفق و approve ناموفق بوده است
            stage: diatechInvoiceId ? 'approve_invoice' : 'create_invoice',
            invoiceId: diatechInvoiceId ?? null,
            error: serializeError(error),
          }),
        );

        // سفارش سایت PAID باقی می‌ماند؛ تراکنش سایت commit شده و rollback
        // ممکن نیست. لاگ ساختاریافتهٔ بالا (با correlationId) برای
        // ردیابی و اقدام دستی در Production کافی است.
      }

      await this.smsService.sendOrderConfirmationToCustomer(
        order.user.phone,
        order.user.fullName,
        order.id.toString(),
      );
      await this.smsService.sendOrderNotificationToAdmin(order.id.toString());

      return this.findOne(order.id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // لغو سفارش به دلیل عدم موفقیت پرداخت (بدون تغییر موجودی)
  async failOrderPayment(orderId: number): Promise<Order> {
    const order = await this.orderRepo.findOne({
      where: { id: orderId },
      relations: { user: true },
    });
    if (!order) throw new NotFoundException('سفارش یافت نشد');
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('فقط سفارشات در انتظار قابل لغو هستند');
    }

    const previousStatus = order.status;
    await this.dataSource.transaction(async manager => {
      order.status = OrderStatus.CANCELLED;
      await manager.save(Order, order);
      await this.firstPurchaseGiftService?.releaseOrderReservation(
        manager,
        order.id,
      );
      await this.botEventsService?.recordOrderStatusTransitionInTransaction(
        manager,
        order,
        previousStatus,
        'payment_failed',
      );
    });

    await this.refundWalletPaymentForOrder(order);

    return this.findOne(order.id);
  }

  async confirmOrderFromWallet(
    orderId: number,
    userId: number,
  ): Promise<Order> {
    const order = await this.findOne(orderId, userId);

    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('فقط سفارشات در انتظار قابل تأیید هستند');
    }

    const finalPrice = Number(order.finalPrice);
    const walletPayment = Number(order.walletPayment ?? 0);
    const clubCreditPayment = Number(order.clubCreditPayment ?? 0);

    if (walletPayment + clubCreditPayment < finalPrice) {
      throw new BadRequestException(
        'مجموع اعتبارهای انتخابی برای پوشش کامل سفارش کافی نیست.',
      );
    }

    // این مسیر جایگزین «انتقال به درگاه» است؛ همان بررسی پیش از پرداخت
    await this.assertStockForPurchase(
      order.items ?? [],
      'wallet_confirm',
      userId,
      order.id,
    );

    return this.confirmOrderPayment(orderId);
  }

  private async refundWalletPaymentForOrder(order: Order): Promise<void> {
    const walletPayment = Number(order.walletPayment ?? 0);

    if (walletPayment <= 0 || !order.user) {
      return;
    }

    const debitKey = `wallet-order-${order.id}`;

    try {
      const debitTx = await this.walletService.getTransactionByKey(debitKey);

      if (!debitTx) {
        // سهم کیف پول هرگز کسر نشده؛ چیزی برای عودت نیست
        return;
      }

      await this.walletService.refundWallet(order.user.id, walletPayment, {
        transactionKey: `wallet-order-${order.id}-refund`,
        description: `عودت کیف پول به دلیل لغو سفارش ${order.orderNumber}`,
        meta: { orderId: order.id, orderNumber: order.orderNumber },
      });

      await this.botEventsService?.recordOrderWalletRefund({
        orderId: order.id,
        orderNumber: order.orderNumber,
        refundedAmount: walletPayment,
        transactionKey: `wallet-order-${order.id}-refund`,
      });

      this.logger.log(
        `✅ سهم کیف پول سفارش ${order.id} (${walletPayment} تومان) عودت داده شد.`,
      );
    } catch (error) {
      this.logger.error(
        `❌ عودت سهم کیف پول سفارش ${order.id} ناموفق بود؛ نیاز به بررسی دستی دارد.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  // دریافت یک سفارش
  /**
   * پیش‌نمایش زندهٔ چک‌اوت: همان محاسباتی که ثبت سفارش انجام می‌دهد، بدون
   * ثبت چیزی. صفحهٔ چک‌اوت و پشتیبانی همین اعداد را می‌بینند.
   */
  async previewCheckout(
    userId: number,
    dto: {
      shippingMethod?: ShippingMethod;
      discountCode?: string;
      useFirstPurchaseGift?: boolean;
    } = {},
  ) {
    const cart = await this.cartRepo.findOne({
      where: { user: { id: userId } },
      relations: {
        items: {
          variant: { product: { categories: true } },
        },
      },
    });

    if (!cart || !cart.items?.length) {
      throw new BadRequestException('سبد خرید خالی است.');
    }

    const pricedLines = await this.discountService.priceCartLines(
      cart.items.map(item => ({
        productId: item.variant.product.id,
        quantity: item.quantity,
        price: Number(item.variant.price),
        categoryIds:
          item.variant.product.categories?.map(category => category.id) ?? [],
      })),
    );

    const promotionCart = buildPricedPromotionCart(
      cart,
      cart.items.map((item, index) => {
        const priced = pricedLines[index];

        return {
          item,
          originalPrice: priced?.originalPrice ?? Number(item.variant.price),
          unitPrice: priced?.unitPrice ?? Number(item.variant.price),
        };
      }),
    );

    const promotionResult = this.promotionsService
      ? await this.promotionsService.evaluateCart({
          cart: promotionCart,
          userId,
        })
      : EMPTY_PROMOTION_RESULT;

    const promotionByLine = new Map<
      number,
      {
        amount: number;
        isFree: boolean;
        labels: string[];
        promotionIds: number[];
      }
    >();

    for (const evaluation of promotionResult.applied) {
      for (const allocation of evaluation.allocations) {
        const lineId = Number(allocation.lineId);

        if (!Number.isFinite(lineId)) {
          continue;
        }

        const current = promotionByLine.get(lineId) ?? {
          amount: 0,
          isFree: false,
          labels: [],
          promotionIds: [],
        };

        current.amount += allocation.isFree ? 0 : allocation.amount;
        current.isFree = current.isFree || allocation.isFree;

        if (!current.labels.includes(allocation.label)) {
          current.labels.push(allocation.label);
        }

        if (!current.promotionIds.includes(evaluation.promotionId)) {
          current.promotionIds.push(evaluation.promotionId);
        }

        promotionByLine.set(lineId, current);
      }
    }

    for (const item of cart.items) {
      if (item.promotionRewardId != null) {
        const current = promotionByLine.get(item.id) ?? {
          amount: 0,
          isFree: false,
          labels: [],
          promotionIds: [],
        };

        current.isFree = true;
        current.promotionIds = [
          ...new Set([...current.promotionIds, item.promotionRewardId]),
        ];
        current.labels = ['رایگان (هدیه پروموشن)'];
        promotionByLine.set(item.id, current);
      }
    }

    const lines = cart.items.map((item, index) => {
      const priced = pricedLines[index];
      const promotion = promotionByLine.get(item.id);
      const saleTotal = priced.unitPrice * item.quantity;
      const lineSaleDiscount =
        (priced.originalPrice - priced.unitPrice) * item.quantity;

      return {
        lineId: item.id,
        variantId: item.variant.id,
        productId: item.variant.product.id,
        title: item.variant.product.title,
        slug: item.variant.product.slug,
        image: item.variant.product.image,
        colorName: item.variant.color?.name ?? null,
        sizeName: item.variant.size?.name ?? null,
        quantity: item.quantity,
        originalPrice: priced.originalPrice,
        salePrice: priced.unitPrice,
        saleDiscount: lineSaleDiscount,
        promotionDiscount: promotion?.isFree
          ? saleTotal
          : Math.min(promotion?.amount ?? 0, saleTotal),
        isFreeReward: !!item.promotionRewardId || !!promotion?.isFree,
        promotionRewardId: item.promotionRewardId ?? null,
        promotionLabel: promotion?.labels.join('، ') ?? null,
        promotionIds: promotion?.promotionIds ?? [],
      };
    });

    const subtotalAfterSale = lines.reduce(
      (sum, line) =>
        sum + line.salePrice * line.quantity - line.promotionDiscount,
      0,
    );

    const freeShipping = promotionResult.freeShipping;
    const shippingMethod = dto.shippingMethod;
    const shippingCost = freeShipping
      ? 0
      : this.calculateShippingCost(shippingMethod);

    let codeDiscountAmount = 0;
    if (dto.discountCode?.trim()) {
      const result = await this.discountService.validateDiscount(
        dto.discountCode.trim(),
        userId,
        pricedLines.map(line => ({
          productId: line.productId,
          quantity: line.quantity,
          price: line.unitPrice,
          categoryIds: line.categoryIds,
          isOnSale: line.isOnSale,
        })),
      );
      codeDiscountAmount = Number(result.discountAmount);
    }

    let firstPurchaseGiftDiscount = 0;
    if (dto.useFirstPurchaseGift) {
      if (!this.firstPurchaseGiftService) {
        throw new BadRequestException('هدیهٔ اولین خرید در دسترس نیست.');
      }
      const gift =
        await this.firstPurchaseGiftService.getDiscountConfigForUser(userId);
      if (!gift.eligible) {
        throw new BadRequestException(
          'این حساب شرایط استفاده از هدیهٔ اولین خرید آنلاین را ندارد.',
        );
      }
      if (dto.discountCode?.trim() && !gift.settings.stackWithDiscountCodes) {
        throw new BadRequestException(
          'هدیهٔ اولین خرید با کد تخفیف قابل استفاده همزمان نیست.',
        );
      }
      const eligibleSubtotal = cart.items.reduce((sum, item, index) => {
        const promo = promotionByLine.get(item.id);
        if (
          (pricedLines[index].isOnSale && !gift.settings.stackWithSalePrices) ||
          item.promotionRewardId != null ||
          promo?.isFree ||
          Number(promo?.amount ?? 0) > 0
        ) {
          return sum;
        }
        return sum + pricedLines[index].unitPrice * item.quantity;
      }, 0);
      if (eligibleSubtotal <= 0) {
        throw new BadRequestException(
          'سبد خرید محصولی با قیمت عادی برای استفاده از هدیهٔ اولین خرید ندارد.',
        );
      }
      firstPurchaseGiftDiscount = calculateFirstPurchaseGiftDiscount(
        eligibleSubtotal,
        Number(gift.settings.discountPercent),
      );
    }

    return {
      data: {
        lines,
        promotions: {
          applied: promotionResult.applied,
          rejected: promotionResult.rejected,
          notices: promotionResult.notices,
          suggestions: promotionResult.suggestions,
        },
        totals: {
          originalPrice: lines.reduce(
            (sum, line) => sum + line.originalPrice * line.quantity,
            0,
          ),
          saleDiscount: lines.reduce((sum, line) => sum + line.saleDiscount, 0),
          promotionDiscount: lines.reduce(
            (sum, line) => sum + line.promotionDiscount,
            0,
          ),
          discountCode: codeDiscountAmount,
          firstPurchaseGiftDiscount,
          freeItemValue: promotionResult.totalFreeItemValue,
          shippingCost,
          freeShipping,
          finalPrice: Math.max(
            0,
            subtotalAfterSale +
              shippingCost -
              codeDiscountAmount -
              firstPurchaseGiftDiscount,
          ),
        },
      },
    };
  }

  async findOne(id: number, userId?: number): Promise<Order> {
    const where: any = { id };
    if (userId) {
      where.user = { id: userId };
    }
    const order = await this.orderRepo.findOne({
      where,
      relations: {
        user: true,
        items: {
          variant: {
            color: true,
            size: true,
            product: true,
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException('سفارش یافت نشد');
    }
    return order;
  }

  async findAll(
    userId: number,
    query: QueryDto,
  ): Promise<{ data: Order[]; pagination: any; stats: any }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    // ۱. دریافت داده‌های صفحه‌بندی‌شده
    const qb = this.orderRepo
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'items')
      .leftJoinAndSelect('items.variant', 'variant')
      .leftJoinAndSelect('variant.color', 'color')
      .leftJoinAndSelect('variant.size', 'size')
      .leftJoinAndSelect('variant.product', 'product')
      .where('order.user = :userId', { userId })
      .orderBy('order.createdAt', 'DESC');

    const { skip, take } = getPagination(page, limit);
    qb.skip(skip).take(take);

    const [data, total] = await qb.getManyAndCount();

    /**
     * ۲. محاسبه آمار — شمارشِ صریحِ هر وضعیت در **یک** کوئری.
     *
     * چرا به‌جای چند `count()` جداگانه: شمارش‌ها باید با هم سازگار بمانند و
     * هر وضعیت دقیقاً همان جایی شمرده شود که نامش می‌گوید. وضعیتِ ناشناس در
     * سطلِ `unknown` می‌رود، نه در «تحویل شده»؛ بنابراین سفارشِ لغوشده یا در
     * انتظار پرداخت نمی‌تواند «تحویل شده» دیده شود.
     */
    const statusRows = await this.orderRepo
      .createQueryBuilder('order')
      .select('order.status', 'status')
      .addSelect('COUNT(order.id)', 'count')
      .where('order.user = :userId', { userId })
      .groupBy('order.status')
      .getRawMany<{ status: string; count: string | number }>();

    const counts = summarizeOrderStatusCounts(statusRows);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      stats: {
        total: counts.total,
        awaitingPayment: counts.awaitingPayment,
        processing: counts.processing,
        shipped: counts.shipped,
        delivered: counts.delivered,
        cancelled: counts.cancelled,
        unknown: counts.unknown,
        /** برای سازگاری با مصرف‌کننده‌های قدیمی‌تر همان تعریف قبلی را دارد */
        inProgress: counts.inProgress,
      },
    };
  }

  // لغو سفارش (فقط اگر pending باشد)
  async cancelOrder(id: number, userId: number): Promise<Order> {
    const order = await this.findOne(id, userId);

    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('فقط سفارشات در انتظار قابل لغو هستند');
    }

    // برگرداندن موجودی
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const previousStatus = order.status;
      order.status = OrderStatus.CANCELLED;
      await queryRunner.manager.save(order);
      await this.firstPurchaseGiftService?.releaseOrderReservation(
        queryRunner.manager,
        order.id,
      );
      await this.botEventsService?.recordOrderStatusTransitionInTransaction(
        queryRunner.manager,
        order,
        previousStatus,
        'customer',
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    await this.refundWalletPaymentForOrder(order);

    return this.findOne(id, userId);
  }

  // (برای ادمین) تغییر وضعیت سفارش
  async updateStatus(id: number, status: OrderStatus): Promise<Order> {
    const order = await this.orderRepo.findOne({
      where: { id },
      relations: { user: true },
    });
    if (!order) {
      throw new NotFoundException('سفارش یافت نشد');
    }

    const previousStatus = order.status;
    const wasCancelled = previousStatus === OrderStatus.CANCELLED;

    await this.dataSource.transaction(async manager => {
      order.status = status;
      if (
        [OrderStatus.PAID, OrderStatus.SHIPPED, OrderStatus.DELIVERED].includes(
          status,
        )
      )
        order.torobWasPaid = true;
      await manager.save(Order, order);
      await this.botEventsService?.recordOrderStatusTransitionInTransaction(
        manager,
        order,
        previousStatus,
        'admin',
      );
    });

    if (status === OrderStatus.CANCELLED && !wasCancelled) {
      await this.refundWalletPaymentForOrder(order);
    }

    return this.orderRepo.findOneOrFail({
      where: { id },
      relations: {
        items: {
          variant: {
            color: true,
            size: true,
            product: true,
          },
        },
        user: true,
      },
    });
  }

  // محاسبه تعداد سفارشات کاربر
  async countUserOrders(userId: number): Promise<number> {
    return this.orderRepo.count({
      where: { user: { id: userId } },
    });
  }

  async findAllForAdmin(query: QueryDto): Promise<{
    data: any[];
    pagination: any;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const qb = this.orderRepo
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'items')
      .leftJoinAndSelect('items.variant', 'variant')
      .leftJoinAndSelect('variant.color', 'color')
      .leftJoinAndSelect('variant.size', 'size')
      .leftJoinAndSelect('variant.product', 'product')
      .leftJoinAndSelect('order.user', 'user')
      .orderBy('order.createdAt', 'DESC');

    applySearch(qb, query.search, [
      'order.orderNumber',
      'user.fullName',
      'user.phone',
      'order.status',
    ]);

    // =========================
    // Pagination
    // =========================

    const { skip, take } = getPagination(page, limit);

    qb.skip(skip).take(take);

    const [data, total] = await qb.getManyAndCount();

    const orderIds = data.map(o => o.id);

    const payments = orderIds.length
      ? await this.paymentRepo.find({
          where: {
            orderId: In(orderIds),
            status: PaymentStatus.SUCCESS,
          },
          select: {
            id: true,
            orderId: true,
            gateway: true,
            amount: true,
            saleReferenceId: true,
            resCode: true,
            createdAt: true,
          },
          order: {
            createdAt: 'ASC',
          },
        })
      : [];

    const paymentsByOrderId = new Map<number, Payment[]>();

    for (const payment of payments) {
      if (payment.orderId === null || payment.orderId === undefined) {
        continue;
      }

      const list = paymentsByOrderId.get(payment.orderId) ?? [];

      list.push(payment);
      paymentsByOrderId.set(payment.orderId, list);
    }

    /*
     * وضعیت ثبت فاکتور در راهکاران با یک کوئری برای کل صفحه خوانده
     * می‌شود تا پنل ادمین بدون درخواست جدا برای هر ردیف، بداند فاکتور
     * هر سفارش ثبت شده یا نیاز به بررسی دارد.
     */
    const rahkaranSyncByOrderId = await this.loadRahkaranSyncStatuses(orderIds);

    return {
      data: data.map(order => ({
        ...order,
        paymentBreakdown: this.buildPaymentBreakdown(order, paymentsByOrderId),
        rahkaranInvoice: this.buildRahkaranInvoiceSummary(
          rahkaranSyncByOrderId.get(order.id),
        ),
      })),

      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // دریافت یک سفارش برای شروع پرداخت - با بررسی مالکیت کاربر
  // (اگر سفارش متعلق به کاربر نباشد، همان «یافت نشد» برمی‌گردد تا وجود سفارش افشا نشود)
  async findOneForPayment(id: number, userId: number): Promise<Order> {
    const order = await this.orderRepo.findOne({
      where: {
        id,
        user: {
          id: userId,
        },
      },
      relations: {
        user: true,
        address: {
          city: true,
          province: true,
        },
        items: {
          variant: {
            color: true,
            size: true,
            product: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('سفارش یافت نشد');
    }

    return order;
  }

  // دریافت یک سفارش بدون فیلتر کاربر - برای ادمین
  async findOneForAdmin(id: number) {
    const order = await this.orderRepo.findOne({
      where: { id },
      relations: {
        user: true,
        address: {
          city: true,
          province: true,
        },
        items: {
          variant: {
            color: true,
            size: true,
            product: true,
          },
        },
      },
    });

    const payments = await this.paymentRepo.find({
      where: {
        orderId: id,
        status: PaymentStatus.SUCCESS,
      },
      select: {
        id: true,
        orderId: true,
        gateway: true,
        amount: true,
        saleReferenceId: true,
        resCode: true,
        createdAt: true,
        // اطلاعات خرید اعتباری/اقساطی دیجی‌پی برای نمایش در پنل ادمین
        digipayPurchaseType: true,
        digipayPaymentGateway: true,
        creditProvider: true,
        repaymentOption: true,
        digipayDeliveredAt: true,
      },
      order: {
        createdAt: 'ASC',
      },
    });

    const paymentsByOrderId = new Map<number, Payment[]>();

    for (const payment of payments) {
      if (payment.orderId === null || payment.orderId === undefined) {
        continue;
      }

      const list = paymentsByOrderId.get(payment.orderId) ?? [];

      list.push(payment);
      paymentsByOrderId.set(payment.orderId, list);
    }

    if (!order) {
      throw new NotFoundException('سفارش یافت نشد');
    }

    const rahkaranSync = await this.loadRahkaranSyncStatuses([order.id]);

    return {
      ...order,
      paymentBreakdown: this.buildPaymentBreakdown(order, paymentsByOrderId),
      rahkaranInvoice: this.buildRahkaranInvoiceSummary(
        rahkaranSync.get(order.id),
      ),
    };
  }

  // لغو سفارش توسط ادمین (با ثبت دلیل)
  async adminCancelOrder(id: number, reason?: string): Promise<Order> {
    const order = await this.findOneForAdmin(id);

    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException('این سفارش قبلاً لغو شده است');
    }

    // برگرداندن موجودی
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const previousStatus = order.status;
      order.status = OrderStatus.CANCELLED;
      // می‌توانید دلیل لغو را در فیلدی مثل `note` ذخیره کنید
      if (reason) {
        order.note = order.note
          ? `${order.note}\nدلیل لغو توسط ادمین: ${reason}`
          : `دلیل لغو توسط ادمین: ${reason}`;
      }
      await queryRunner.manager.save(order);
      await this.firstPurchaseGiftService?.releaseOrderReservation(
        queryRunner.manager,
        order.id,
      );
      await this.botEventsService?.recordOrderStatusTransitionInTransaction(
        queryRunner.manager,
        order,
        previousStatus,
        'admin',
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    await this.refundWalletPaymentForOrder(order);

    return this.findOneForAdmin(id);
  }

  private calculateShippingCost(shippingMethod?: ShippingMethod): number {
    // Post and Tipax are prepaid at a fixed rate; courier is paid on delivery
    // and pickup is free. Free-shipping promotions waive the prepaid charge
    // before this function is called.
    return getShippingCostToman(shippingMethod);
  }

  /**
   * وضعیت ثبت فاکتور راهکاران برای چند سفارش.
   *
   * اگر ماژول راهکاران در دسترس نباشد (محیط بدون آن)، نقشهٔ خالی برمی‌گردد
   * و پاسخ ادمین مثل قبل کار می‌کند.
   */
  private async loadRahkaranSyncStatuses(
    orderIds: number[],
  ): Promise<Map<number, RahkaranInvoiceSync>> {
    if (!this.rahkaranInvoiceSyncService || !orderIds?.length) {
      return new Map();
    }

    try {
      return await this.rahkaranInvoiceSyncService.getSyncStatusesForOrders(
        orderIds,
      );
    } catch (error) {
      // وضعیت راهکاران نباید دیدن سفارش‌ها در پنل ادمین را بشکند.
      this.logger.warn(
        `خواندن وضعیت ثبت فاکتور راهکاران ناموفق بود: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return new Map();
    }
  }

  /**
   * خلاصهٔ قابل نمایش وضعیت فاکتور راهکاران در پنل ادمین.
   * `null` یعنی این سفارش هنوز در جدول ردیابی راهکاران رکوردی ندارد.
   */
  private buildRahkaranInvoiceSummary(sync?: RahkaranInvoiceSync) {
    if (!sync) {
      return null;
    }

    return {
      status: sync.status,
      attempts: sync.attempts,
      invoiceId: sync.invoiceId,
      invoiceNumber: sync.invoiceNumber,
      lastError: sync.lastError,
      lastAttemptAt: sync.lastAttemptAt,
      succeededAt: sync.succeededAt,
      lastCorrelationId: sync.lastCorrelationId,
      /*
       * true یعنی نتیجهٔ تلاش قبلی نامعلوم بوده و ارسال دوباره تا بررسی
       * دستی در راهکاران متوقف شده است.
       */
      needsReconciliation: !!sync.reconcileRequiredAt,
      reconcileRequiredAt: sync.reconcileRequiredAt,
      reconcileReason: sync.reconcileReason,
    };
  }

  private buildPaymentBreakdown(
    order: Order,
    paymentsByOrderId: Map<number, Payment[]>,
  ) {
    const finalPrice = Number(order.finalPrice ?? 0);
    const walletAmount = Number(order.walletPayment ?? 0);
    const clubCreditAmount = Number(order.clubCreditPayment ?? 0);

    const orderPayments = (paymentsByOrderId.get(order.id) ?? []).map(p => {
      const digipay = describeDigipayPurchase(p);

      return {
        paymentId: p.id,
        gateway: p.gateway,
        gatewayLabel: this.getGatewayLabel(p.gateway),
        amount: Number(p.amount) / 10,
        saleReferenceId: p.saleReferenceId,
        resCode: p.resCode,
        createdAt: p.createdAt,
        /** برچسب ابزار پرداخت دیجی‌پی: کیف پول / اعتبار / BNPL / اینترنتی */
        digipayInstrument: digipay?.label ?? null,
        /** تعداد اقساط (1 = یک‌جا، 4 = چهار قسط) */
        digipayInstallments: digipay?.installments ?? null,
        digipayCreditProvider: digipay?.creditProvider ?? null,
        /** زمان اعلام تحویل خرید اعتباری به دیجی‌پی */
        digipayDeliveredAt: p.digipayDeliveredAt ?? null,
      };
    });

    const gatewayAmount = orderPayments.reduce(
      (sum, p) => sum + Number(p.amount),
      0,
    );

    let type: 'wallet' | 'gateway' | 'mixed' | 'pending' | 'cancelled';

    if (order.status === OrderStatus.CANCELLED) {
      type = 'cancelled';
    } else if (
      walletAmount + clubCreditAmount >= finalPrice &&
      finalPrice > 0
    ) {
      type = 'wallet';
    } else if (walletAmount + clubCreditAmount > 0 && gatewayAmount > 0) {
      type = 'mixed';
    } else if (gatewayAmount > 0) {
      type = 'gateway';
    } else {
      type = 'pending';
    }

    return {
      type,
      finalPrice,
      walletAmount,
      clubCreditAmount,
      gatewayAmount,
      // در صورت mixed ممکن است walletAmount + gatewayAmount == finalPrice نباشد
      // (مثلاً گرد کردن ریالی یا خطای انسانی). هر دو مقدار برای ادمین
      // مفید هستند، پس جمع و اختلاف هم برگردانده می‌شود.
      paidTotal: walletAmount + clubCreditAmount + gatewayAmount,
      remaining: Math.max(
        0,
        finalPrice - walletAmount - clubCreditAmount - gatewayAmount,
      ),
      gateways: orderPayments,
    };
  }

  private getGatewayLabel(gateway: PaymentGateway): string {
    switch (gateway) {
      case PaymentGateway.MELLAT:
        return 'ملت';
      case PaymentGateway.ZARINPAL:
        return 'زرین‌پال';
      case PaymentGateway.DIGIPAY:
        return 'دیجی‌پی';
      case PaymentGateway.TARA:
        return 'تارا';
      case PaymentGateway.SNAPPAY:
        return 'اسنپ‌پی';
      default:
        return String(gateway);
    }
  }
}

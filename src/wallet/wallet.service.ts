import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';

import { Wallet } from './entities/wallet.entity';
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';

export interface WalletMutationOptions {
  transactionKey?: string;

  description?: string;

  /** داده‌های تکمیلی که روی تراکنش ذخیره می‌شود (orderId، ...) */
  meta?: Record<string, any>;
}

interface WalletMutationParams {
  type: WalletTransactionType;
  direction: WalletTransactionDirection;
  amount: number;
  description?: string;
  meta?: Record<string, any>;
  /** تراکنش اصلی که در حال برگشت است (مخصوص type=REVERSAL) */
  reversedTransaction?: WalletTransaction;
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepo: Repository<Wallet>,

    @InjectRepository(WalletTransaction)
    private readonly txRepo: Repository<WalletTransaction>,

    private readonly dataSource: DataSource,
  ) {}

  // =========================================================
  // خوانش
  // =========================================================

  async getWalletByUserId(userId: number): Promise<Wallet | null> {
    return this.walletRepo.findOne({ where: { user: { id: userId } } });
  }

  /**
   * دریافت کیف پول؛ اگر وجود ندارد (اولین استفاده) می‌سازد.
   */
  async getOrCreateWallet(userId: number): Promise<Wallet> {
    const existing = await this.getWalletByUserId(userId);

    if (existing) {
      return existing;
    }

    const wallet = this.walletRepo.create({
      user: { id: userId },
      balance: 0,
      totalCharged: 0,
      totalSpent: 0,
      totalRefunded: 0,
    });

    try {
      return await this.walletRepo.save(wallet);
    } catch (error) {
      // اگر دو درخواست همزمان کیف پول را ساخته باشند، دومین با خطای
      // duplicate-key مواجه می‌شود؛ در آن حالت رکورد ساخته‌شده را برگردان.
      if (this.isDuplicateKeyError(error)) {
        const winner = await this.getWalletByUserId(userId);

        if (winner) {
          return winner;
        }
      }

      throw error;
    }
  }

  /** موجودی فعلی (0 اگر کاربر هنوز کیف پول ندارد) */
  async getBalance(userId: number): Promise<number> {
    const wallet = await this.getWalletByUserId(userId);

    return wallet ? Number(wallet.balance) : 0;
  }

  /**
   * دریافت تراکنش با کلید idempotency (برای آدیت و retry‌های امن).
   */
  async getTransactionByKey(
    transactionKey: string,
  ): Promise<WalletTransaction | null> {
    return this.txRepo.findOne({ where: { transactionKey } });
  }

  async getTransactions(
    userId: number,
    page: number,
    limit: number,
    type?: WalletTransactionType,
  ): Promise<{
    data: WalletTransaction[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    const wallet = await this.getWalletByUserId(userId);

    if (!wallet) {
      return {
        data: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
      };
    }

    const where: Record<string, any> = { wallet: { id: wallet.id } };

    if (type) {
      where.type = type;
    }

    const [data, total] = await this.txRepo.findAndCount({
      where,
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // =========================================================
  // سرویس‌های اصلی (برای فراخوانی از سایر ماژول‌ها/سرویس‌ها)
  // =========================================================

  /**
   * شارژ (واریز) به کیف پول کاربر.
   *
   * این همان سرویسی است که سرویس‌های دیگر برای شارژ کیف پول
   * فراخوانی می‌کنند. با `transactionKey` idempotent است.
   *
   * @example
   * await walletService.chargeWallet(userId, 500000, {
   *   transactionKey: 'promo-user7-moharram',
   *   description: 'شارژ هدیهٔ جشنواره',
   * });
   */
  async chargeWallet(
    userId: number,
    amount: number,
    options: WalletMutationOptions = {},
  ): Promise<WalletTransaction> {
    const key = options.transactionKey ?? `wallet-charge-${randomUUID()}`;

    return this.applyMutation(
      userId,
      {
        type: WalletTransactionType.CHARGE,
        direction: WalletTransactionDirection.CREDIT,
        amount,
        description: options.description ?? 'شارژ کیف پول',
        meta: options.meta,
      },
      key,
    );
  }

  /**
   * کسر از کیف پول (خرید). در صورت ناکافی بودن موجودی خطا می‌دهد.
   * با `transactionKey` idempotent است.
   */
  async debitWallet(
    userId: number,
    amount: number,
    options: WalletMutationOptions = {},
  ): Promise<WalletTransaction> {
    const key = options.transactionKey ?? `wallet-debit-${randomUUID()}`;

    return this.applyMutation(
      userId,
      {
        type: WalletTransactionType.PURCHASE,
        direction: WalletTransactionDirection.DEBIT,
        amount,
        description: options.description ?? 'خرید از کیف پول',
        meta: options.meta,
      },
      key,
    );
  }

  /**
   * عودت به کیف پول (واریز با نوع refund).
   * با `transactionKey` idempotent است.
   */
  async refundWallet(
    userId: number,
    amount: number,
    options: WalletMutationOptions = {},
  ): Promise<WalletTransaction> {
    const key = options.transactionKey ?? `wallet-refund-${randomUUID()}`;

    return this.applyMutation(
      userId,
      {
        type: WalletTransactionType.REFUND,
        direction: WalletTransactionDirection.CREDIT,
        amount,
        description: options.description ?? 'عودت به کیف پول',
        meta: options.meta,
      },
      key,
    );
  }

  /**
   * برگشت یک تراکنش قبلی (با کلید idempotency آن).
   *
   * جهت تراکنش برعکس تراکنش اصلی اعمال می‌شود؛ مثلاً برگشت یک debit
   * (خرید) یک credit می‌سازد. اگر تراکنش اصلی یافت نشود یا قبلاً
   * برگشت خورده باشد، `null` برمی‌گرداند (idempotent).
   */
  async reverseTransaction(
    userId: number,
    originalTransactionKey: string,
    options: WalletMutationOptions = {},
  ): Promise<WalletTransaction | null> {
    const original = await this.txRepo.findOne({
      where: { transactionKey: originalTransactionKey },
    });

    if (!original) {
      return null;
    }

    if (original.status === WalletTransactionStatus.REVERSED) {
      return null;
    }

    if (original.type === WalletTransactionType.REVERSAL) {
      // برگشتِ برگشت معنا ندارد
      return null;
    }

    const reversalKey = `${originalTransactionKey}#reversal`;

    const existingReversal = await this.txRepo.findOne({
      where: { transactionKey: reversalKey },
    });

    if (existingReversal) {
      return existingReversal;
    }

    return this.applyMutation(
      userId,
      {
        type: WalletTransactionType.REVERSAL,
        direction:
          original.direction === WalletTransactionDirection.CREDIT
            ? WalletTransactionDirection.DEBIT
            : WalletTransactionDirection.CREDIT,
        amount: Number(original.amount),
        description:
          options.description ?? `برگشت تراکنش ${originalTransactionKey}`,
        meta: {
          ...options.meta,
          reversedTransactionKey: originalTransactionKey,
        },
        reversedTransaction: original,
      },
      reversalKey,
    );
  }

  // =========================================================
  // خصوصی
  // =========================================================

  private assertAmount(amount: number): void {
    const num = Number(amount);

    if (!Number.isFinite(num) || num <= 0) {
      throw new BadRequestException('مبلغ تراکنش کیف پول نامعتبر است');
    }
  }

  /**
   * اعمال یک تغییر روی موجودی کیف پول داخل تراکنش دیتابیس.
   *
   * مراحل:
   * ۱. بررسی idempotency (اگر همان کلید قبلاً ثبت شده، همان را برگردان)
   * ۲. قفل رکورد کیف پول (pessimistic write lock)
   * ۳. محاسبهٔ موجودی جدید + به‌روزرسانی جمع‌های تجمعی
   * ۴. ثبت رکورد در ledger
   */
  private async applyMutation(
    userId: number,
    params: WalletMutationParams,
    transactionKey: string,
  ): Promise<WalletTransaction> {
    this.assertAmount(params.amount);

    try {
      return await this.dataSource.transaction(async manager => {
        // ۱. idempotency
        const existing = await manager.findOne(WalletTransaction, {
          where: { transactionKey },
        });

        if (existing) {
          return existing;
        }

        // ۲. قفل رکورد کیف پول تا تغییرات همزمان روی موجودی از هم سربزنند
        let wallet = await manager.findOne(Wallet, {
          where: { user: { id: userId } },
          lock: { mode: 'pessimistic_write' },
        });

        if (!wallet) {
          wallet = manager.create(Wallet, {
            user: { id: userId },
            balance: 0,
            totalCharged: 0,
            totalSpent: 0,
            totalRefunded: 0,
          });

          try {
            wallet = await manager.save(Wallet, wallet);
          } catch (error) {
            if (this.isDuplicateKeyError(error)) {
              // یک تراکنش همزمان کیف پول را ساخته است
              wallet = await manager.findOne(Wallet, {
                where: { user: { id: userId } },
              });

              if (!wallet) {
                throw error;
              }
            } else {
              throw error;
            }
          }
        }

        // ۳. محاسبهٔ موجودی جدید
        const balance = Number(wallet.balance);
        const amount = Number(params.amount);
        let newBalance: number;

        if (params.direction === WalletTransactionDirection.CREDIT) {
          newBalance = balance + amount;
        } else {
          if (balance < amount) {
            throw new BadRequestException('موجودی کیف پول کافی نیست');
          }

          newBalance = balance - amount;
        }

        wallet.balance = newBalance;
        this.applyTotals(wallet, params, amount);

        await manager.save(Wallet, wallet);

        // ۴. ثبت در ledger
        const transaction = manager.create(WalletTransaction, {
          wallet,
          transactionKey,
          type: params.type,
          direction: params.direction,
          amount,
          balanceAfter: newBalance,
          description: params.description ?? null,
          meta: params.meta ?? null,
          status: WalletTransactionStatus.SUCCESS,
        });

        await manager.save(WalletTransaction, transaction);

        // اگر این تراکنش «برگشت» است، تراکنش اصلی را REVERSED علامت می‌زنیم
        if (
          params.type === WalletTransactionType.REVERSAL &&
          params.reversedTransaction
        ) {
          await manager.update(
            WalletTransaction,
            { id: params.reversedTransaction.id },
            { status: WalletTransactionStatus.REVERSED },
          );
        }

        return transaction;
      });
    } catch (error) {
      /*
       * دو فراخوانی همزمان با یک transactionKey: اولی commit کرده و دومی
       * به unique constraint می‌خورد؛ تراکنشِ ثبت‌شده را برگردان تا
       * caller رفتار idempotent ببیند.
       */
      if (this.isDuplicateKeyError(error)) {
        const existing = await this.txRepo.findOne({
          where: { transactionKey },
        });

        if (existing) {
          this.logger.warn(
            `درخواست تکراری تراکنش کیف پول ${transactionKey} — تراکنش قبلی (id ${existing.id}) برگردانده شد.`,
          );

          return existing;
        }
      }

      throw error;
    }
  }

  /** به‌روزرسانی جمع‌های تجمعی کیف پول بر اساس نوع تراکنش */
  private applyTotals(
    wallet: Wallet,
    params: WalletMutationParams,
    amount: number,
  ): void {
    switch (params.type) {
      case WalletTransactionType.CHARGE:
        wallet.totalCharged = Number(wallet.totalCharged) + amount;
        break;

      case WalletTransactionType.PURCHASE:
        wallet.totalSpent = Number(wallet.totalSpent) + amount;
        break;

      case WalletTransactionType.REFUND:
        wallet.totalRefunded = Number(wallet.totalRefunded) + amount;
        break;

      case WalletTransactionType.REVERSAL:
        this.applyReversalTotals(wallet, params, amount);
        break;

      case WalletTransactionType.ADJUSTMENT:
        // تنظیم دستی روی جمع‌های تجمعی اثر نمی‌گذارد
        break;
    }
  }

  private applyReversalTotals(
    wallet: Wallet,
    params: WalletMutationParams,
    amount: number,
  ): void {
    const original = params.reversedTransaction;

    if (!original) {
      return;
    }

    // جمعِ نوع اصلی را به اندازهٔ برگشت کم می‌کنیم (زیر صفر نمی‌رود)
    if (original.type === WalletTransactionType.PURCHASE) {
      wallet.totalSpent = Math.max(0, Number(wallet.totalSpent) - amount);
    } else if (original.type === WalletTransactionType.CHARGE) {
      wallet.totalCharged = Math.max(0, Number(wallet.totalCharged) - amount);
    } else if (original.type === WalletTransactionType.REFUND) {
      wallet.totalRefunded = Math.max(0, Number(wallet.totalRefunded) - amount);
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    const anyError = error as any;

    return (
      anyError?.code === 'ER_DUP_ENTRY' ||
      anyError?.errno === 1062 ||
      (typeof anyError?.message === 'string' &&
        anyError.message.includes('Duplicate entry'))
    );
  }
}

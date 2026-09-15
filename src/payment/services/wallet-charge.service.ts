import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  WalletCharge,
  WalletChargeStatus,
} from 'src/wallet/entities/wallet-charge.entity';
import { WalletService } from 'src/wallet/wallet.service';
import { Repository } from 'typeorm';

import { Payment, PaymentGateway } from '../entities/payment.entity';

@Injectable()
export class WalletChargeService {
  private readonly logger = new Logger(WalletChargeService.name);

  constructor(
    @InjectRepository(WalletCharge)
    private readonly chargeRepo: Repository<WalletCharge>,

    private readonly walletService: WalletService,
  ) {}

  async createPendingCharge(
    userId: number,
    amount: number,
    gateway: PaymentGateway,
  ): Promise<WalletCharge> {
    const charge = this.chargeRepo.create({
      user: { id: userId },
      amount,
      gateway,
      status: WalletChargeStatus.PENDING,
    });

    return this.chargeRepo.save(charge);
  }

  async getChargeWithUser(chargeId: number): Promise<WalletCharge | null> {
    return this.chargeRepo.findOne({
      where: { id: chargeId },
      relations: { user: true },
    });
  }

  /**
   * پس از verify موفق درگاه: مبلغ را به کیف پول کاربر واریز کن و
   * درخواست شارژ را SUCCESS ثبت کن.
   *
   * idempotent است: اگر قبلاً واریز شده باشد (callback تکراری)،
   * دوباره واریز نمی‌کند.
   */
  async settleCharge(payment: Payment): Promise<void> {
    if (!payment.walletChargeId) {
      throw new NotFoundException(
        'درخواست شارژ کیف پولی برای این پرداخت یافت نشد',
      );
    }

    const charge = await this.chargeRepo.findOne({
      where: { id: payment.walletChargeId },
    });

    if (!charge) {
      throw new NotFoundException('درخواست شارژ کیف پول یافت نشد');
    }

    if (charge.status === WalletChargeStatus.SUCCESS) {
      // قبلاً واریز شده (callback تکراری) — کاری نمی‌کنیم
      return;
    }

    await this.walletService.chargeWallet(
      charge.user.id,
      Number(charge.amount),
      {
        transactionKey: `wallet-charge-${charge.id}`,
        description: 'شارژ کیف پول از طریق درگاه پرداخت',
        meta: {
          chargeId: charge.id,
          paymentId: payment.id,
          gateway: payment.gateway,
        },
      },
    );

    charge.status = WalletChargeStatus.SUCCESS;
    await this.chargeRepo.save(charge);

    this.logger.log(
      `✅ شارژ ${charge.id} (${charge.amount} تومان) به کیف پول کاربر ${charge.user.id} واریز شد.`,
    );
  }

  /**
   * هنگام شکست پرداخت در درگاه: درخواست شارژ را FAILED ثبت کن.
   * (هرگز روی یک شارژ SUCCESS اثر نمی‌گذارد)
   */
  async markChargeFailed(payment: Payment): Promise<void> {
    if (!payment.walletChargeId) {
      return;
    }

    await this.markChargeFailedById(payment.walletChargeId);
  }

  async markChargeFailedById(chargeId: number): Promise<void> {
    const charge = await this.chargeRepo.findOne({ where: { id: chargeId } });

    if (!charge || charge.status === WalletChargeStatus.SUCCESS) {
      return;
    }

    charge.status = WalletChargeStatus.FAILED;
    await this.chargeRepo.save(charge);
  }
}

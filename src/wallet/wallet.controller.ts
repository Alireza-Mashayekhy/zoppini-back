import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from 'src/common/guards/auth.guard';

import { MyTransactionsQueryDto } from './dto/my-transactions-query.dto';
import { WalletService } from './wallet.service';

@Controller('wallet')
@UseGuards(AuthGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  /** اطلاعات و موجودی کیف پول کاربر */
  @Get()
  async getMyWallet(@Request() req) {
    const userId: number = req.user.id;

    const wallet = await this.walletService.getOrCreateWallet(userId);

    return {
      walletId: wallet.id,
      balance: Number(wallet.balance),
      totalCharged: Number(wallet.totalCharged),
      totalSpent: Number(wallet.totalSpent),
      totalRefunded: Number(wallet.totalRefunded),
      createdAt: wallet.createdAt,
    };
  }

  /** تاریخچهٔ تراکنش‌های کیف پول کاربر (با صفحه‌بندی) */
  @Get('transactions')
  async getMyTransactions(
    @Request() req,
    @Query() query: MyTransactionsQueryDto,
  ) {
    const userId: number = req.user.id;
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    return this.walletService.getTransactions(userId, page, limit, query.type);
  }
}

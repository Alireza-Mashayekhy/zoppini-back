import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

import { WalletTransactionType } from '../entities/wallet-transaction.entity';

/** فیلترهای تاریخچهٔ تراکنش‌های کیف پول کاربر */
export class MyTransactionsQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsEnum(WalletTransactionType)
  type?: WalletTransactionType;
}

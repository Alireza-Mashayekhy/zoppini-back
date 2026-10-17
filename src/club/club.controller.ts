import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Request,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from 'src/common/guards/auth.guard';

import { ClubService } from './club.service';

interface AuthenticatedUser {
  id?: number;
  phone?: string;
  fullName?: string;
  email?: string | null;
  birthDate?: string | Date | null;
}

@Controller('club')
export class ClubController {
  private readonly logger = new Logger(ClubController.name);

  constructor(private readonly clubService: ClubService) {}

  // ============================================================
  // ثبت مشتری (سازگاری با endpoint قبلی)
  // ============================================================

  @Post()
  async createInvoice(@Body() body) {
    return this.clubService.registerCustomer(body);
  }

  // ============================================================
  // اطلاعات باشگاه مشتریان کاربر لاگین‌شده
  // ============================================================

  /**
   * اطلاعات کامل کاربر در باشگاه دایاتک:
   * امتیاز، اعتبار، کیف پول‌ها، بن‌ها، برچسب‌ها و ...
   */
  @Get('me')
  @UseGuards(AuthGuard)
  async getMyClubInfo(@Request() req) {
    return this.getCustomerForUser(req.user as AuthenticatedUser);
  }

  /**
   * کیف پول‌های کاربر در باشگاه دایاتک
   */
  @Get('wallets')
  @UseGuards(AuthGuard)
  async getMyWallets(@Request() req) {
    const customer = await this.getCustomerForUser(
      req.user as AuthenticatedUser,
    );

    return this.clubService.getCustomerWallets(customer.CustomerCode);
  }

  /**
   * تراکنش‌های یکی از کیف پول‌های کاربر در باشگاه دایاتک
   */
  @Get('wallets/:customerWalletId/transactions')
  @UseGuards(AuthGuard)
  async getMyWalletTransactions(
    @Request() req,
    @Param('customerWalletId', ParseIntPipe) customerWalletId: number,
  ) {
    const user = req.user as AuthenticatedUser;

    const customer = await this.getCustomerForUser(user);

    // فقط تراکنش کیف پول‌های خود کاربر قابل دریافت است
    const walletIds = (customer.Wallets ?? []).map(wallet => wallet.Id);

    if (!walletIds.includes(customerWalletId)) {
      throw new ForbiddenException('این کیف پول متعلق به شما نیست.');
    }

    return this.clubService.getCustomerWalletTransactions(customerWalletId);
  }

  /**
   * تاریخچه وفاداری کاربر (امتیاز / اعتبار / بن)
   */
  @Get('loyalty-histories')
  @UseGuards(AuthGuard)
  async getMyLoyaltyHistories(@Request() req) {
    const customer = await this.getCustomerForUser(
      req.user as AuthenticatedUser,
    );

    return this.clubService.getCustomerLoyaltyHistories(customer.CustomerCode);
  }

  /**
   * پرداختی‌ها و دریافتی‌های کاربر در باشگاه دایاتک
   */
  @Get('payments')
  @UseGuards(AuthGuard)
  async getMyPayments(@Request() req) {
    const customer = await this.getCustomerForUser(
      req.user as AuthenticatedUser,
    );

    return this.clubService.getCustomerPayments(customer.CustomerCode);
  }

  /**
   * سطوح وفاداری باشگاه
   */
  @Get('levels')
  @UseGuards(AuthGuard)
  async getLevels() {
    return this.clubService.getLoyaltyLevels();
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * دریافت مشتری معادل کاربر لاگین‌شده از دایاتک.
   *
   * کد مشتری در دایاتک = شماره موبایل کاربر (همان‌طور که هنگام ثبت‌نام ثبت شده).
   * اگر مشتری در دایاتک پیدا نشد، یک بار تلاش می‌کنیم او را ثبت کنیم
   * (برای کاربرانی که ثبت‌نام آن‌ها در دایاتک ناموفق بوده است).
   */
  private async getCustomerForUser(user: AuthenticatedUser) {
    const customerCode = user?.phone;

    if (!customerCode) {
      throw new UnauthorizedException('اطلاعات کاربر یافت نشد.');
    }

    try {
      return await this.clubService.getCustomer(customerCode);
    } catch {
      this.logger.warn(
        `مشتری ${customerCode} در دایاتک پیدا نشد؛ تلاش برای ثبت‌نام...`,
      );

      try {
        const [firstName, ...lastNameParts] = (user.fullName || '')
          .trim()
          .split(' ');

        await this.clubService.registerCustomer({
          firstName: firstName || customerCode,
          lastName: lastNameParts.join(' ') || '',
          customerCode,
          email: user.email || null,
          birthDate: user.birthDate
            ? new Date(user.birthDate).toISOString()
            : null,
        });

        return await this.clubService.getCustomer(customerCode);
      } catch (registerError) {
        this.logger.error(
          `دریافت اطلاعات باشگاه مشتری ${customerCode} ناموفق بود.`,
          registerError instanceof Error
            ? registerError.message
            : String(registerError),
        );

        throw new NotFoundException(
          'اطلاعات شما در باشگاه مشتریان یافت نشد. لطفاً بعداً دوباره تلاش کنید.',
        );
      }
    }
  }
}

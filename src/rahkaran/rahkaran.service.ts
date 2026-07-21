// src/rahkaran/rahkaran.service.ts
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import dayjs from 'dayjs';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';

import { OrdersService } from '../order/order.service';
import { Color } from '../products/entities/product-color.entity';
import { Size } from '../products/entities/product-size.entity';
import { ProductsService } from '../products/products.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class RahkaranService implements OnModuleInit {
  private readonly logger = new Logger(RahkaranService.name);
  private readonly baseUrl: string;
  private authCookie: string = '';
  private isAuthenticated = false;
  private readonly defaultStoreId = 1;
  private readonly defaultShopId = 1;
  private readonly loyaltyPatternId = 2; // شناسه طرح وفاداری در راهکاران

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    @Inject(forwardRef(() => ProductsService))
    private readonly productsService: ProductsService,
    @Inject(forwardRef(() => OrdersService))
    private readonly ordersService: OrdersService,
    @InjectRepository(Color)
    private colorRepo: Repository<Color>,
    @InjectRepository(Size)
    private sizeRepo: Repository<Size>,
  ) {
    this.baseUrl =
      this.configService.get('RAHKARAN_BASE_URL') || 'http://192.168.100.100';
  }

  // ============================
  // 🔐 احراز هویت (اجرای خودکار در شروع)
  // ============================
  async onModuleInit() {
    const username = this.configService.get('RAHKARAN_USERNAME');
    const password = this.configService.get('RAHKARAN_PASSWORD');
    const machineName = this.configService.get('RAHKARAN_MACHINE_NAME');

    if (!username || !password || !machineName) {
      this.logger.warn('⚠️ اطلاعات احراز هویت راهکاران تنظیم نشده است.');
      return;
    }

    try {
      await this.authenticate(username, password);
      await this.cashierLogin(machineName);
      this.logger.log('✅ احراز هویت راهکاران با موفقیت انجام شد.');
    } catch (error) {
      this.logger.error('❌ خطا در احراز هویت راهکاران', error.message);
    }
  }

  async authenticate(username: string, password: string): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/SG/Services/Retail/RetailAuthenticationService.svc/Authenticate`;
      const response = await firstValueFrom(
        this.httpService.post(url, { UserName: username, Password: password }),
      );

      if (response.data?.IsSuccessful) {
        const setCookie = response.headers['set-cookie'];
        if (setCookie) {
          this.authCookie = Array.isArray(setCookie)
            ? setCookie.join('; ')
            : setCookie;
        }
        this.isAuthenticated = true;
        this.logger.log('✅ احراز هویت موفق');
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error('❌ خطا در احراز هویت', error.message);
      throw new BadRequestException('خطا در احراز هویت راهکاران');
    }
  }

  async cashierLogin(machineName: string): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/SG/Services/Retail/RetailAuthenticationService.svc/CashierLogin`;
      const headers = { Cookie: this.authCookie };
      const response = await firstValueFrom(
        this.httpService.post(url, { MachineName: machineName }, { headers }),
      );

      if (response.data?.IsSuccessful) {
        this.logger.log('✅ ورود به صندوق موفق');
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error('❌ خطا در ورود به صندوق', error.message);
      throw new BadRequestException('خطا در ورود به صندوق راهکاران');
    }
  }

  // ============================================================
  // 🎯 هدف ۱: دریافت فاکتورهای مشتری از راهکاران
  // ============================================================
  async getCustomerInvoices(userId: number): Promise<any[]> {
    const user = await this.usersService.findOne(userId);
    if (!user) throw new NotFoundException('کاربر یافت نشد');

    if (!user.nationalCode) {
      this.logger.warn(`کاربر ${userId} کد ملی ندارد.`);
      return [];
    }

    const rahkaranId = await this.findCustomerByNationalId(user.nationalCode);
    if (!rahkaranId) {
      this.logger.warn(`کاربر ${userId} در راهکاران ثبت نشده است.`);
      return [];
    }

    const url = `${this.baseUrl}/SG/Services/Retail/ESales.svc/invoices?customerId=${rahkaranId}&pageNumber=1&pageSize=100`;
    const response = await this.getRequest(url);
    return response?.result || [];
  }

  // ============================================================
  // 🎯 هدف ۲: یکسان‌سازی محصولات (کد، قیمت، موجودی)
  // ============================================================
  async syncProducts(
    shopId: number = this.defaultShopId,
    storeId: number = this.defaultStoreId,
  ) {
    let from = 0;
    const pageSize = 100;
    let hasMore = true;
    let totalSynced = 0;
    let totalVariants = 0;

    while (hasMore) {
      const url = `${this.baseUrl}/SG/Services/Retail/ESales.svc/Products?shopId=${shopId}&storeId=${storeId}&from=${from}&numberOfRecords=${pageSize}`;
      const response = await this.getRequest(url);
      const products = response?.result || [];

      if (products.length === 0) {
        hasMore = false;
        break;
      }

      for (const p of products) {
        // ۲-۱: پیدا یا ایجاد محصول
        let product = await this.productsService.findByCode(p.code);
        if (!product) {
          // ایجاد محصول با یک تصویر خالی
          product = await this.productsService.create(
            {
              productCode: p.code,
              title: p.name,
              slug: p.code,
              description: p.specification || '',
              careInstructionsHtml: '',
              categoryIds: [],
              variants: [], // اضافه شد
            },
            undefined,
          );
          this.logger.log(`✅ محصول جدید ایجاد شد: ${p.name} (${p.code})`);
        }

        // ۲-۲: همگام‌سازی واریانت‌ها
        const variants = await this.productsService.getVariantsByProductId(
          product.id,
        );
        if (variants.length === 0) {
          // ایجاد یک واریانت پیش‌فرض
          const defaultColor = await this.getDefaultColor();
          const defaultSize = await this.getDefaultSize();
          await this.productsService.addVariant({
            productId: product.id,
            colorId: defaultColor.id,
            sizeId: defaultSize.id,
            price: 0,
            stock: 0,
            sku: p.code,
          });
        }

        // ۲-۳: به‌روزرسانی قیمت و موجودی
        const priceData = await this.getProductPrice(p.id, 0);
        const remaining = await this.getRemaining(p.id, storeId);

        const allVariants = await this.productsService.getVariantsByProductId(
          product.id,
        );
        for (const variant of allVariants) {
          await this.productsService.updateVariant(variant.id, {
            price: priceData?.fee || 0,
            stock: remaining || 0,
          });
          totalVariants++;
        }

        totalSynced++;
      }

      this.logger.log(
        `${products.length} محصول در مرحله ${from} همگام‌سازی شد.`,
      );
      from += pageSize;
    }

    this.logger.log(
      `✅ همگام‌سازی کامل: ${totalSynced} محصول و ${totalVariants} واریانت.`,
    );
    return { totalProducts: totalSynced, totalVariants };
  }

  // ============================================================
  // 🎯 هدف ۳: عضویت وفادار در زمان ثبت‌نام کاربر
  // ============================================================
  async createLoyaltyMemberForUser(
    userId: number,
    patternId: number = this.loyaltyPatternId,
  ): Promise<number> {
    const user = await this.usersService.findOne(userId);
    if (!user) throw new NotFoundException('کاربر یافت نشد');
    if (!user.nationalCode) {
      throw new BadRequestException('کاربر کد ملی ندارد');
    }

    const rahkaranId = await this.syncCustomerToRahkaran(userId);
    const loyaltyId = await this.createLoyaltyMember(rahkaranId, patternId);
    this.logger.log(
      `✅ عضو وفادار برای کاربر ${userId} با شناسه ${loyaltyId} ایجاد شد.`,
    );
    return loyaltyId;
  }

  // ============================================================
  // 🎯 هدف ۴: به‌روزرسانی آنی موجودی و قیمت یک محصول خاص
  // ============================================================
  async updateProductStockAndPrice(
    productId: number,
    storeId: number = this.defaultStoreId,
  ): Promise<void> {
    const product = await this.productsService.findById(productId);
    if (!product) throw new NotFoundException('محصول یافت نشد');

    const remaining = await this.getRemaining(productId, storeId);
    const priceData = await this.getProductPrice(productId, 0);

    const variants =
      await this.productsService.getVariantsByProductId(productId);
    for (const variant of variants) {
      await this.productsService.updateVariant(variant.id, {
        price: priceData?.fee || 0,
        stock: remaining || 0,
      });
    }

    this.logger.log(
      `✅ موجودی و قیمت محصول ${productId} به‌روز شد. موجودی: ${remaining}, قیمت: ${priceData?.fee}`,
    );
  }

  // ============================================================
  // 🧩 متدهای کمکی
  // ============================================================

  // --- مدیریت مشتری ---
  async syncCustomerToRahkaran(userId: number): Promise<number> {
    const user = await this.usersService.findOne(userId);
    if (!user) throw new NotFoundException('کاربر یافت نشد');

    if (!user.nationalCode) {
      throw new BadRequestException('کاربر کد ملی ندارد');
    }

    let rahkaranId = await this.findCustomerByNationalId(user.nationalCode);
    if (!rahkaranId && user.phone) {
      rahkaranId = await this.findCustomerByMobile(user.phone);
    }

    if (!rahkaranId) {
      rahkaranId = await this.createCustomer({
        firstName: user.fullName?.split(' ')[0] || 'کاربر',
        lastName: user.fullName?.split(' ').slice(1).join(' ') || '',
        nationalCode: user.nationalCode,
        mobile: user.phone,
        gender: null,
        birthdate: user.birthDate
          ? dayjs(user.birthDate).format('YYYY-MM-DD')
          : null,
      });
      this.logger.log(
        `✅ مشتری جدید در راهکاران ایجاد شد. شناسه: ${rahkaranId}`,
      );
    }

    // ذخیره شناسه راهکاران در کاربر
    await this.usersService.update(userId, { rahkaranId });
    return rahkaranId;
  }

  async findCustomerByNationalId(nationalId: string): Promise<number> {
    if (!nationalId) return 0;
    const url = `${this.baseUrl}/SG/Services/Retail/ESales.svc/customers?nationalID=${nationalId}`;
    const response = await this.getRequest(url);
    return response?.result?.[0]?.id || 0;
  }

  async findCustomerByMobile(mobile: string): Promise<number> {
    if (!mobile) return 0;
    const url = `${this.baseUrl}/SG/Services/Retail/ESales.svc/customers?mobile=${mobile}`;
    const response = await this.getRequest(url);
    return response?.result?.[0]?.id || 0;
  }

  async createCustomer(customerData: any): Promise<number> {
    const url = `${this.baseUrl}/SG/Services/Retail/ESales.svc/Customer`;
    const payload = {
      firstName: customerData.firstName,
      lastName: customerData.lastName,
      nationalCode: customerData.nationalCode,
      mobile: customerData.mobile,
      gender: customerData.gender,
      birthdate: customerData.birthdate,
    };
    const response = await this.postRequest(url, payload);
    return response?.result || 0;
  }

  async createLoyaltyMember(
    customerId: number,
    patternId: number,
  ): Promise<number> {
    const url = `${this.baseUrl}/SG/Services/Retail/LoyaltyESales.svc/loyaltyMember`;
    const body = {
      loyaltyMemberPatternId: patternId,
      customerId,
    };
    const response = await this.postRequest(url, body);
    return response?.result || 0;
  }

  async getProductPrice(
    productId: number,
    customerId: number = 0,
  ): Promise<any> {
    const url = `${this.baseUrl}/SG/Services/Retail/ESales.svc/Price`;
    const body = {
      customerId,
      currencyId: 1,
      retailShopId: this.defaultShopId,
      date: dayjs().format('YYYY/MM/DD'),
      salesAreaId: 1,
      items: [
        {
          itemId: 0,
          productId,
          trackingFactors: [],
          unitId: 1,
          quantity: 1,
        },
      ],
    };
    const response = await this.postRequest(url, body);
    return response?.result?.[0] || null;
  }

  async getRemaining(
    productId: number,
    storeId: number,
    date?: string,
  ): Promise<number> {
    const url = `${this.baseUrl}/SG/Services/Retail/ESales.svc/Remaining`;
    const body = {
      productId,
      storeId,
      dateTime: date || dayjs().format('YYYY/MM/DD'),
    };
    const response = await this.postRequest(url, body);
    return response?.result || 0;
  }

  async createSalesOrder(orderData: any): Promise<number> {
    const payload = {
      document: {
        customerId: orderData.customerId,
        currencyId: orderData.currencyId || 1,
        settlementPolicyId: orderData.settlementPolicyId || 1,
        storeId: orderData.storeId || 1,
        documentPatternId: orderData.documentPatternId || 2,
        items: orderData.items.map(item => ({
          productId: item.productId,
          unitId: item.unitId || 1,
          quantity: item.quantity,
          storeId: item.storeId || orderData.storeId || 1,
          fee: item.price,
          price: item.price,
          netPrice: item.price,
        })),
        payments: orderData.payments || [],
        discountCardSerials: orderData.discountCardSerials || [],
      },
    };

    const url = `${this.baseUrl}/SG/Services/Retail/ESales.svc/salesOrder`;
    const response = await this.postRequest(url, payload);
    return response?.result?.id || 0;
  }

  // src/rahkaran/rahkaran.service.ts

  // ============================================================
  // 🎯 یکپارچه‌سازی سفارش: ثبت سفارش در راهکاران
  // ============================================================
  async syncOrderToRahkaran(orderId: number): Promise<number> {
    const order = await this.ordersService.findOne(orderId);
    if (!order) {
      throw new BadRequestException('سفارش یافت نشد');
    }

    const user = order.user;
    if (!user) throw new BadRequestException('کاربر سفارش یافت نشد');

    const rahkaranId = await this.syncCustomerToRahkaran(user.id);

    const orderData = {
      customerId: rahkaranId,
      currencyId: 1,
      settlementPolicyId: 1,
      storeId: 1,
      documentPatternId: 2,
      items: order.items.map(item => ({
        productId: item.variant.productId,
        unitId: 1,
        quantity: item.quantity,
        storeId: 1,
        price: item.price,
      })),
      payments: [],
      discountCardSerials: [],
    };

    return this.createSalesOrder(orderData);
  }

  // --- رنگ و سایز پیش‌فرض (برای محصولات ساده) ---
  private async getDefaultColor(): Promise<Color> {
    const color = await this.colorRepo.findOne({ where: { id: 1 } });
    if (!color) throw new Error('رنگ پیش‌فرض (id=1) یافت نشد');
    return color;
  }

  private async getDefaultSize(): Promise<Size> {
    const size = await this.sizeRepo.findOne({ where: { id: 1 } });
    if (!size) throw new Error('سایز پیش‌فرض (id=1) یافت نشد');
    return size;
  }

  // --- درخواست‌های HTTP با کوکی ---
  private async getRequest(url: string) {
    if (!this.isAuthenticated) {
      throw new BadRequestException('احراز هویت نشده است. ابتدا لاگین کنید.');
    }
    const headers = { Cookie: this.authCookie };
    try {
      const response = await firstValueFrom(
        this.httpService.get(url, { headers }),
      );
      return response.data;
    } catch (error) {
      this.logger.error(`❌ خطا در GET: ${url}`, error.message);
      if (error.response?.status === 401) {
        this.isAuthenticated = false;
        throw new BadRequestException(
          'نشست منقضی شده است. لطفاً مجدداً احراز هویت کنید.',
        );
      }
      throw error;
    }
  }

  private async postRequest(url: string, data: any) {
    if (!this.isAuthenticated) {
      throw new BadRequestException('احراز هویت نشده است. ابتدا لاگین کنید.');
    }
    const headers = { Cookie: this.authCookie };
    try {
      const response = await firstValueFrom(
        this.httpService.post(url, data, { headers }),
      );
      return response.data;
    } catch (error) {
      this.logger.error(`❌ خطا در POST: ${url}`, error.message);
      if (error.response?.status === 401) {
        this.isAuthenticated = false;
        throw new BadRequestException(
          'نشست منقضی شده است. لطفاً مجدداً احراز هویت کنید.',
        );
      }
      throw error;
    }
  }
}

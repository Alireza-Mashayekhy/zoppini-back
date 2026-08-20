import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ProductsService } from './products.service';

@Injectable()
export class ProductsScheduler {
  private readonly logger = new Logger(ProductsScheduler.name);

  constructor(private readonly productsService: ProductsService) {}

  /**
   * هر روز ساعت 04:00 صبح به وقت ایران
   */
  @Cron('0 0 4 * * *', {
    name: 'rahkaran-products-sync',
    timeZone: 'Asia/Tehran',
    waitForCompletion: true,
  })
  async syncProductsWithRahkaran() {
    this.logger.log('🌙 شروع Sync روزانه محصولات با راهکاران - ساعت 04:00');

    try {
      await this.productsService.syncAllProductsWithRahkaran();

      this.logger.log('✅ Sync روزانه محصولات با راهکاران با موفقیت تمام شد.');
    } catch (error) {
      this.logger.error(
        '❌ Sync روزانه محصولات با راهکاران شکست خورد.',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * جداول سیستم پروموشن + ستون‌های سفارش/سبد.
 *
 * این مایگریشن محافظه‌کار است (مثل AddDigipayUgpFields):
 * - هر جدول/ستون فقط اگر وجود نداشته باشد ساخته/اضافه می‌شود.
 * - در محیط توسعه `synchronize` هم همین تغییرات را می‌سازد، اما در
 *   production فقط این مایگریشن اجرا می‌شود؛ پس باید کامل باشد.
 * - down فقط ستون‌های همین مایگریشن را حذف می‌کند.
 */
export class PromotionSystem1802000000000 implements MigrationInterface {
  private async tableExists(q: QueryRunner, table: string) {
    const rows: { COUNT: string | number }[] = await q.query(
      `SELECT COUNT(*) AS COUNT FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );

    return Number(rows?.[0]?.COUNT ?? 0) > 0;
  }

  private async columnExists(q: QueryRunner, table: string, column: string) {
    const rows: { COUNT: string | number }[] = await q.query(
      `SELECT COUNT(*) AS COUNT FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );

    return Number(rows?.[0]?.COUNT ?? 0) > 0;
  }

  private async addColumn(
    q: QueryRunner,
    table: string,
    column: string,
    definition: string,
  ) {
    if (!(await this.tableExists(q, table))) {
      return;
    }

    if (await this.columnExists(q, table, column)) {
      return;
    }

    await q.query(
      `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`,
    );
  }

  async up(q: QueryRunner): Promise<void> {
    // =====================================================
    // promotions
    // =====================================================

    if (!(await this.tableExists(q, 'promotions'))) {
      await q.query(`
        CREATE TABLE \`promotions\` (
          \`id\` int NOT NULL AUTO_INCREMENT,
          \`name\` varchar(200) NOT NULL,
          \`internalDescription\` text NULL,
          \`type\` enum('cheaper_item_pair','buy_x_get_y_same_group','buy_trigger_get_reward','spend_and_save','buy_x_get_percent_off','fixed_price_bundle','free_shipping','cart_discount') NOT NULL,
          \`scope\` enum('all','categories','products','categories_and_products') NOT NULL DEFAULT 'all',
          \`rewardType\` enum('percentage','fixed','free_item','free_shipping','fixed_bundle_price') NOT NULL,
          \`rewardValue\` decimal(12,2) NULL,
          \`maxDiscountAmount\` decimal(12,2) NULL,
          \`minQuantity\` int NOT NULL DEFAULT 0,
          \`minCartValue\` decimal(15,2) NOT NULL DEFAULT 0.00,
          \`pairSize\` int NOT NULL DEFAULT 2,
          \`discountEveryExtraUnit\` tinyint NOT NULL DEFAULT 0,
          \`requiredQuantity\` int NOT NULL DEFAULT 0,
          \`freeQuantity\` int NOT NULL DEFAULT 0,
          \`rewardScope\` enum('all','categories','products','categories_and_products') NULL,
          \`suggestedProductId\` int NULL,
          \`suggestedCategoryId\` int NULL,
          \`rewardQuantity\` int NOT NULL DEFAULT 1,
          \`freeItemSelection\` enum('auto','customer') NOT NULL DEFAULT 'auto',
          \`autoAddReward\` tinyint NOT NULL DEFAULT 0,
          \`requiresCustomerAcceptance\` tinyint NOT NULL DEFAULT 0,
          \`removeRewardWhenTriggerRemoved\` tinyint NOT NULL DEFAULT 1,
          \`isActive\` tinyint NOT NULL DEFAULT 1,
          \`startsAt\` datetime NOT NULL,
          \`expiresAt\` datetime NOT NULL,
          \`maxTotalUses\` int NULL,
          \`maxUsesPerCustomer\` int NULL,
          \`maxApplicationsPerCart\` int NOT NULL DEFAULT 1,
          \`canStack\` tinyint NOT NULL DEFAULT 0,
          \`stackable\` tinyint NOT NULL DEFAULT 0,
          \`priority\` int NOT NULL DEFAULT 0,
          \`badgeText\` varchar(120) NULL,
          \`customerDescription\` varchar(300) NULL,
          \`showBadgeOnProductCard\` tinyint NOT NULL DEFAULT 0,
          \`showBadgeOnProductPage\` tinyint NOT NULL DEFAULT 0,
          \`showPreCartPopup\` tinyint NOT NULL DEFAULT 0,
          \`popupTitle\` varchar(150) NULL,
          \`popupDescription\` text NULL,
          \`popupAcceptLabel\` varchar(100) NULL,
          \`popupDismissLabel\` varchar(100) NULL,
          \`popupSuggestedProductId\` int NULL,
          \`popupSuggestedCategoryId\` int NULL,
          \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          PRIMARY KEY (\`id\`),
          INDEX \`IDX_promotions_type\` (\`type\`),
          INDEX \`IDX_promotions_active\` (\`isActive\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    }

    // =====================================================
    // join tables
    // =====================================================

    const joinTables: { name: string; column: string; target: string }[] = [
      { name: 'promotion_products', column: 'product_id', target: 'product' },
      { name: 'promotion_categories', column: 'category_id', target: 'category' },
      {
        name: 'promotion_excluded_products',
        column: 'product_id',
        target: 'product',
      },
      {
        name: 'promotion_excluded_categories',
        column: 'category_id',
        target: 'category',
      },
      {
        name: 'promotion_reward_products',
        column: 'product_id',
        target: 'product',
      },
      {
        name: 'promotion_reward_categories',
        column: 'category_id',
        target: 'category',
      },
    ];

    for (const join of joinTables) {
      if (await this.tableExists(q, join.name)) {
        continue;
      }

      await q.query(`
        CREATE TABLE \`${join.name}\` (
          \`promotion_id\` int NOT NULL,
          \`${join.column}\` int NOT NULL,
          PRIMARY KEY (\`promotion_id\`, \`${join.column}\`),
          INDEX \`IDX_${join.name}_${join.column}\` (\`${join.column}\`),
          CONSTRAINT \`FK_${join.name}_promotion\` FOREIGN KEY (\`promotion_id\`)
            REFERENCES \`promotions\`(\`id\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    }

    // =====================================================
    // redemptions / events
    // =====================================================

    if (!(await this.tableExists(q, 'promotion_redemptions'))) {
      await q.query(`
        CREATE TABLE \`promotion_redemptions\` (
          \`id\` int NOT NULL AUTO_INCREMENT,
          \`promotion_id\` int NOT NULL,
          \`user_id\` int NULL,
          \`order_id\` int NOT NULL,
          \`discountAmount\` decimal(15,2) NOT NULL DEFAULT 0.00,
          \`usedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          PRIMARY KEY (\`id\`),
          INDEX \`IDX_promotion_redemptions_promotion\` (\`promotion_id\`),
          INDEX \`IDX_promotion_redemptions_user\` (\`user_id\`),
          INDEX \`IDX_promotion_redemptions_order\` (\`order_id\`),
          CONSTRAINT \`FK_promotion_redemptions_promotion\` FOREIGN KEY (\`promotion_id\`)
            REFERENCES \`promotions\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`FK_promotion_redemptions_order\` FOREIGN KEY (\`order_id\`)
            REFERENCES \`order\`(\`id\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    }

    if (!(await this.tableExists(q, 'promotion_events'))) {
      await q.query(`
        CREATE TABLE \`promotion_events\` (
          \`id\` int NOT NULL AUTO_INCREMENT,
          \`promotion_id\` int NOT NULL,
          \`user_id\` int NULL,
          \`kind\` enum('expired','ineligible','out_of_stock','usage_limit','stacking_blocked','reward_accepted','reward_declined','reward_removed','popup_accepted','popup_dismissed') NOT NULL,
          \`message\` varchar(500) NULL,
          \`meta\` json NULL,
          \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          PRIMARY KEY (\`id\`),
          INDEX \`IDX_promotion_events_promotion\` (\`promotion_id\`),
          CONSTRAINT \`FK_promotion_events_promotion\` FOREIGN KEY (\`promotion_id\`)
            REFERENCES \`promotions\`(\`id\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    }

    // =====================================================
    // cart
    // =====================================================

    await this.addColumn(q, 'cart', 'accepted_promotions', 'json NULL');
    await this.addColumn(q, 'cart', 'dismissed_promotions', 'json NULL');
    await this.addColumn(q, 'cart', 'selected_rewards', 'json NULL');
    await this.addColumn(
      q,
      'cart',
      'promotion_popup_shown_for',
      'varchar(64) NULL',
    );

    await this.addColumn(q, 'cart_item', 'promotion_reward_id', 'int NULL');
    await this.addColumn(
      q,
      'cart_item',
      'added_via_promotion',
      'tinyint NOT NULL DEFAULT 0',
    );

    // =====================================================
    // order
    // =====================================================

    await this.addColumn(
      q,
      'order',
      'promotionDiscount',
      'decimal(15,2) NOT NULL DEFAULT 0.00',
    );
    await this.addColumn(
      q,
      'order',
      'promotion_free_item_value',
      'decimal(15,2) NOT NULL DEFAULT 0.00',
    );
    await this.addColumn(q, 'order', 'promotion_snapshot', 'json NULL');
    await this.addColumn(
      q,
      'order',
      'promotion_free_shipping',
      'tinyint NOT NULL DEFAULT 0',
    );

    await this.addColumn(
      q,
      'order_item',
      'promotion_discount',
      'decimal(15,2) NOT NULL DEFAULT 0.00',
    );
    await this.addColumn(
      q,
      'order_item',
      'is_promotion_reward',
      'tinyint NOT NULL DEFAULT 0',
    );
    await this.addColumn(q, 'order_item', 'promotion_reward_id', 'int NULL');
    await this.addColumn(
      q,
      'order_item',
      'promotion_label',
      'varchar(255) NULL',
    );
    await this.addColumn(q, 'order_item', 'promotion_ids', 'json NULL');
  }

  async down(q: QueryRunner): Promise<void> {
    const dropColumns: [string, string][] = [
      ['order_item', 'promotion_ids'],
      ['order_item', 'promotion_label'],
      ['order_item', 'promotion_reward_id'],
      ['order_item', 'is_promotion_reward'],
      ['order_item', 'promotion_discount'],
      ['order', 'promotion_free_shipping'],
      ['order', 'promotion_snapshot'],
      ['order', 'promotion_free_item_value'],
      ['order', 'promotionDiscount'],
      ['cart_item', 'added_via_promotion'],
      ['cart_item', 'promotion_reward_id'],
      ['cart', 'promotion_popup_shown_for'],
      ['cart', 'selected_rewards'],
      ['cart', 'dismissed_promotions'],
      ['cart', 'accepted_promotions'],
    ];

    for (const [table, column] of dropColumns) {
      if (!(await this.tableExists(q, table))) {
        continue;
      }

      if (!(await this.columnExists(q, table, column))) {
        continue;
      }

      await q.query(
        `ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``,
      );
    }

    for (const table of [
      'promotion_events',
      'promotion_redemptions',
      'promotion_reward_categories',
      'promotion_reward_products',
      'promotion_excluded_categories',
      'promotion_excluded_products',
      'promotion_categories',
      'promotion_products',
      'promotions',
    ]) {
      if (await this.tableExists(q, table)) {
        await q.query(`DROP TABLE \`${table}\``);
      }
    }
  }
}

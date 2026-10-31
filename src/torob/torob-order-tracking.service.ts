import { BadRequestException, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import { DataSource, Repository } from 'typeorm';

/** Preserve up to six fractional digits in the SQL comparison (JS Date loses micros). */
export function parseTrackingQuery(timestamp: unknown, limit: unknown) {
  if (
    typeof timestamp !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(timestamp)
  )
    throw new BadRequestException('purchase_timestamp_gt must be ISO 8601 UTC');
  const parsed = new Date(timestamp);
  // Round-trip verifies calendar dates as Date.parse normalizes invalid dates.
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 19) !== timestamp.slice(0, 19)
  )
    throw new BadRequestException('invalid purchase_timestamp_gt');
  if (
    typeof limit !== 'string' ||
    !/^[1-9]\d{0,3}$/.test(limit) ||
    Number(limit) > 1000
  )
    throw new BadRequestException('limit must be between 1 and 1000');
  return {
    after: timestamp.replace('T', ' ').replace('Z', ''),
    limit: Number(limit),
  };
}

function amount(value: unknown): number | undefined {
  const number = Number(value);
  return value != null && Number.isSafeInteger(number) && number >= 0
    ? number
    : undefined;
}

@Injectable()
export class TorobOrderTrackingService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly db: DataSource,
  ) {}

  async list(timestamp: unknown, requestedLimit: unknown) {
    const { after, limit } = parseTrackingQuery(timestamp, requestedLimit);
    const records = await this.orders
      .createQueryBuilder('o')
      .select([
        'o.id AS order_id',
        'o.torob_clid AS clid',
        'o.status AS status',
        'o.totalPrice AS total',
        'o.discount AS discount',
        'o.shippingCost AS shipping',
        "DATE_FORMAT(o.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS purchase_utc",
        "DATE_FORMAT(o.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_utc",
      ])
      .innerJoin(
        'torob_attribution_grants',
        'g',
        'g.id = o.torob_grant_id AND g.active = 1 AND g.expires_at > UTC_TIMESTAMP(3)',
      )
      .where('o.torob_clid IS NOT NULL AND o.torob_clid <> :empty', {
        empty: '',
      })
      .andWhere('o.created_at > :after', { after })
      .andWhere(
        '(o.status IN (:...completed) OR (o.status = :cancelled AND o.torob_was_paid = 1))',
        {
          completed: [
            OrderStatus.PAID,
            OrderStatus.SHIPPED,
            OrderStatus.DELIVERED,
          ],
          cancelled: OrderStatus.CANCELLED,
        },
      )
      .orderBy('o.created_at', 'ASC')
      .addOrderBy('o.id', 'ASC')
      .limit(limit)
      .getRawMany();
    return {
      success: true,
      data: records.map(order => {
        const orderValue = amount(Number(order.total) - Number(order.discount));
        const shipping = amount(order.shipping);
        return {
          purchase_timestamp: order.purchase_utc,
          last_updated_timestamp: order.updated_utc,
          torob_clid: order.clid,
          status:
            order.status === OrderStatus.CANCELLED ? 'cancelled' : 'completed',
          ...(orderValue === undefined ? {} : { order_value: orderValue }),
          ...(shipping === undefined ? {} : { shipping_amount: shipping }),
        };
      }),
    };
  }

  async register(grantId: string) {
    // Never reactivate a revoked grant. Existing active grants retain their original expiry.
    await this.db.query(
      'INSERT IGNORE INTO torob_attribution_grants (id, active, expires_at) VALUES (?, 1, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 180 DAY))',
      [grantId],
    );
    const rows = await this.db.query(
      'SELECT id FROM torob_attribution_grants WHERE id = ? AND active = 1 AND expires_at > UTC_TIMESTAMP(3)',
      [grantId],
    );
    return rows.length > 0;
  }

  async revoke(grantId: string) {
    await this.db.transaction(async manager => {
      await manager.query(
        'INSERT INTO torob_attribution_grants (id, active, expires_at) VALUES (?, 0, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 180 DAY)) ON DUPLICATE KEY UPDATE active = 0',
        [grantId],
      );
      await manager.query(
        'UPDATE `order` SET torob_clid = NULL, torob_grant_id = NULL WHERE torob_grant_id = ?',
        [grantId],
      );
    });
  }

  @Cron('0 4 * * *')
  async removeExpired() {
    await this.db.transaction(async manager => {
      await manager.query(
        'UPDATE `order` o INNER JOIN torob_attribution_grants g ON o.torob_grant_id = g.id SET o.torob_clid = NULL, o.torob_grant_id = NULL WHERE g.expires_at <= UTC_TIMESTAMP(3)',
      );
      await manager.query(
        'DELETE FROM torob_attribution_grants WHERE expires_at <= UTC_TIMESTAMP(3)',
      );
    });
  }
}

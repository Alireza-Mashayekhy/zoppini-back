import 'dotenv/config';

import { BotInventoryAlertState } from 'src/bot-reports/entities/bot-inventory-alert-state.entity';
import { BotOperator } from 'src/bot-reports/entities/bot-operator.entity';
import { BotOutboxEvent } from 'src/bot-reports/entities/bot-outbox-event.entity';
import { BotSetting } from 'src/bot-reports/entities/bot-setting.entity';
import { CreateBotManagementTables1761465600000 } from 'src/migrations/1761465600000-CreateBotManagementTables';
import { CookieAnalytics1793059200000 } from 'src/migrations/1793059200000-CookieAnalytics';
import { AddSnappayGateway1794000000000 } from 'src/migrations/1794000000000-AddSnappayGateway';
import { TorobOrderTracking1795000000000 } from 'src/migrations/1795000000000-TorobOrderTracking';
import { ReportCategoryEvents1796000000000 } from 'src/migrations/1796000000000-ReportCategoryEvents';
import { AddHediehMallPickup1797000000000 } from 'src/migrations/1797000000000-AddHediehMallPickup';
import { DataSource } from 'typeorm';

export default new DataSource({
  type: 'mysql',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? '3306'),
  username: process.env.DATABASE_USERNAME ?? 'root',
  password: process.env.DATABASE_PASSWORD ?? '',
  database: process.env.DATABASE_NAME ?? 'zoppini_db',
  entities: [BotSetting, BotOperator, BotOutboxEvent, BotInventoryAlertState],
  migrations: [
    CreateBotManagementTables1761465600000,
    CookieAnalytics1793059200000,
    AddSnappayGateway1794000000000,
    TorobOrderTracking1795000000000,
    ReportCategoryEvents1796000000000,
    AddHediehMallPickup1797000000000,
  ],
  synchronize: false,
});

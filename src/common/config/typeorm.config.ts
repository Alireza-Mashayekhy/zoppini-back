import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions, TypeOrmOptionsFactory } from '@nestjs/typeorm';
import { CreateBotManagementTables1761465600000 } from 'src/migrations/1761465600000-CreateBotManagementTables';
import { CookieAnalytics1793059200000 } from 'src/migrations/1793059200000-CookieAnalytics';
import { AddSnappayGateway1794000000000 } from 'src/migrations/1794000000000-AddSnappayGateway';
import { TorobOrderTracking1795000000000 } from 'src/migrations/1795000000000-TorobOrderTracking';
import { ReportCategoryEvents1796000000000 } from 'src/migrations/1796000000000-ReportCategoryEvents';
import { AddHediehMallPickup1797000000000 } from 'src/migrations/1797000000000-AddHediehMallPickup';

@Injectable()
export class TypeOrmConfigService implements TypeOrmOptionsFactory {
  constructor(private configService: ConfigService) {}

  createTypeOrmOptions(): TypeOrmModuleOptions {
    const isProd = this.configService.get<string>('NODE_ENV') === 'production';
    const syncOverride = this.configService.get<string>('TYPEORM_SYNCHRONIZE');
    const migrationsRunOverride = this.configService.get<string>(
      'TYPEORM_MIGRATIONS_RUN',
    );

    const synchronize =
      !isProd && (syncOverride !== undefined ? syncOverride === 'true' : true);
    const migrationsRun =
      migrationsRunOverride !== undefined
        ? migrationsRunOverride === 'true'
        : isProd;

    return {
      type: 'mysql',
      host: this.configService.get('DATABASE_HOST'),
      port: +this.configService.get('DATABASE_PORT'),
      username: this.configService.get('DATABASE_USERNAME'),
      password: this.configService.get('DATABASE_PASSWORD'),
      database: this.configService.get('DATABASE_NAME'),
      autoLoadEntities: true,
      synchronize,
      migrations: [
        CreateBotManagementTables1761465600000,
        CookieAnalytics1793059200000,
        AddSnappayGateway1794000000000,
        TorobOrderTracking1795000000000,
        ReportCategoryEvents1796000000000,
        AddHediehMallPickup1797000000000,
      ],
      migrationsRun,

      retryAttempts: 20,
      retryDelay: 3000,
    };
  }
}

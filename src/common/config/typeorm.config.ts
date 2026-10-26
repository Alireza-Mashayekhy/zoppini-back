import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions, TypeOrmOptionsFactory } from '@nestjs/typeorm';
import { CreateBotManagementTables1761465600000 } from 'src/migrations/1761465600000-CreateBotManagementTables';

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
      syncOverride !== undefined ? syncOverride === 'true' : !isProd;
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
      migrations: [CreateBotManagementTables1761465600000],
      migrationsRun,

      retryAttempts: 20,
      retryDelay: 3000,
    };
  }
}

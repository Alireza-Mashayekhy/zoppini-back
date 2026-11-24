import { BadRequestException } from '@nestjs/common';
import { User } from 'src/users/entities/user.entity';
import { UsersService } from 'src/users/users.service';
import { DataSource, QueryRunner, Repository } from 'typeorm';

import { FixUserLoyaltyMemberSyncedAtColumn1809000000000 } from './1809000000000-FixUserLoyaltyMemberSyncedAtColumn';

describe('FixUserLoyaltyMemberSyncedAtColumn1809000000000 & User schema alignment', () => {
  it('matches TypeORM User entity actual table name (`user`, not `users`) and column names', async () => {
    const ds = new DataSource({
      type: 'mysql',
      database: 'zoppini_db',
      entities: [
        `${__dirname}/../**/*.entity.ts`,
        `${__dirname}/../order/entities/order-item.ts`,
      ],
      synchronize: false,
    });
    await (
      ds as unknown as { buildMetadatas: () => Promise<void> }
    ).buildMetadatas();

    const meta = ds.getMetadata(User);
    expect(meta.tableName).toBe('user');

    const dbColumnNames = meta.columns.map(col => col.databaseName);
    expect(dbColumnNames).toEqual(
      expect.arrayContaining([
        'id',
        'fullName',
        'phone',
        'email',
        'password',
        'birthDate',
        'roles',
        'isActive',
        'nationalCode',
        'rahkaranId',
        'loyalty_member_synced_at',
        'createdAt',
        'updatedAt',
      ]),
    );
  });

  it('repairs production schema where `user` exists without `loyalty_member_synced_at` (while `users` does not exist)', async () => {
    const existingColumns = new Set(['id', 'phone', 'rahkaranId']);
    const statements: string[] = [];

    const query = jest.fn((sql: string, params?: string[]) => {
      if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
        const table = params?.[0];
        return Promise.resolve([{ COUNT: table === 'user' ? 1 : 0 }]);
      }

      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
        const table = params?.[0];
        const col = params?.[1] ?? '';
        return Promise.resolve([
          { COUNT: table === 'user' && existingColumns.has(col) ? 1 : 0 },
        ]);
      }

      statements.push(sql);
      if (sql.includes('ADD COLUMN `loyalty_member_synced_at`')) {
        existingColumns.add('loyalty_member_synced_at');
      }
      return Promise.resolve(undefined);
    });

    const runner = { query } as unknown as QueryRunner;
    const migration = new FixUserLoyaltyMemberSyncedAtColumn1809000000000();

    await migration.up(runner);

    expect(statements).toEqual([
      'ALTER TABLE `user` ADD COLUMN `loyalty_member_synced_at` DATETIME(6) NULL',
    ]);

    // اجرای مجدد کاملاً idempotent است
    statements.length = 0;
    await migration.up(runner);
    expect(statements).toHaveLength(0);
  });

  it('self-heals missing `user.loyalty_member_synced_at` at boot in UsersService.onModuleInit when TYPEORM_MIGRATIONS_RUN=false', async () => {
    const existingColumns = new Set(['id', 'phone', 'rahkaranId']);
    const executedAlters: string[] = [];

    const runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn((sql: string, params?: string[]) => {
        if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
          return Promise.resolve([{ COUNT: params?.[0] === 'user' ? 1 : 0 }]);
        }
        if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
          return Promise.resolve([
            {
              COUNT:
                params?.[0] === 'user' && existingColumns.has(params?.[1] ?? '')
                  ? 1
                  : 0,
            },
          ]);
        }
        executedAlters.push(sql);
        existingColumns.add('loyalty_member_synced_at');
        return Promise.resolve(undefined);
      }),
    };

    const dataSource = {
      isInitialized: true,
      createQueryRunner: () => runner,
    } as unknown as DataSource;

    const repo = {} as Repository<User>;
    const service = new UsersService(repo, dataSource);

    await service.onModuleInit();

    expect(executedAlters).toEqual([
      'ALTER TABLE `user` ADD COLUMN `loyalty_member_synced_at` DATETIME(6) NULL',
    ]);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('maps MySQL ER_DUP_ENTRY (1062) on concurrent user creation to BadRequestException instead of HTTP 500', async () => {
    const dupPhoneError = Object.assign(
      new Error("Duplicate entry '09123456789' for key 'user.IDX_phone'"),
      { code: 'ER_DUP_ENTRY', errno: 1062 },
    );
    const repo = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn().mockRejectedValueOnce(dupPhoneError),
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as Repository<User>;

    const service = new UsersService(repo);
    await expect(
      service.create({
        fullName: 'تست',
        phone: '09123456789',
        code: '12345',
        password: 'password123',
      }),
    ).rejects.toThrow(
      new BadRequestException('کاربر با این شماره تلفن وجود دارد'),
    );

    const dupEmailError = Object.assign(
      new Error("Duplicate entry 'a@b.com' for key 'user.IDX_email'"),
      { code: 'ER_DUP_ENTRY', errno: 1062 },
    );
    (repo.save as jest.Mock).mockRejectedValueOnce(dupEmailError);
    await expect(
      service.create({
        fullName: 'تست',
        phone: '09123456789',
        email: 'a@b.com',
        code: '12345',
        password: 'password123',
      }),
    ).rejects.toThrow(new BadRequestException('کاربر با این ایمیل وجود دارد'));
  });
});

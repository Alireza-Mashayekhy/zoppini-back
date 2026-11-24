import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  applySearch,
  applySort,
  getPagination,
  QueryDto,
} from 'src/common/query';
import { DataSource, Repository } from 'typeorm';

import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';

function isDuplicateEntryError(error: unknown): boolean {
  const err = error as {
    code?: string;
    errno?: number;
    driverError?: { code?: string; errno?: number; message?: string };
  };
  const code = err?.code ?? err?.driverError?.code;
  const errno = err?.errno ?? err?.driverError?.errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User) private usersRepository: Repository<User>,
    @Optional() private readonly dataSource?: DataSource,
  ) {}

  /**
   * Backstop دفاعی برای ستون `user.loyalty_member_synced_at` (مایگریشن‌های
   * 1808000000000 و 1809000000000).
   * اگر در محیطی `TYPEORM_MIGRATIONS_RUN=false` باشد و مایگریشن دستی هنوز اجرا
   * نشده باشد، فقدان این ستون تمام درخواست‌های تایید OTP در ورود و ثبت‌نام را
   * با خطای `Unknown column 'User.loyalty_member_synced_at'` (HTTP 500) متوقف
   * می‌کند. در دیتابیس‌های مایگریت‌شده این بررسی صرفاً یک کوئری متادیتای سبک و
   * بدون تغییر است.
   */
  async onModuleInit() {
    const ds = this.dataSource ?? this.usersRepository?.manager?.connection;
    if (
      !ds ||
      !ds.isInitialized ||
      typeof ds.createQueryRunner !== 'function'
    ) {
      return;
    }

    const runner = ds.createQueryRunner();
    try {
      await runner.connect();

      const tableRows: { COUNT: string | number }[] = await runner.query(
        `SELECT COUNT(*) AS COUNT FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        ['user'],
      );
      if (Number(tableRows?.[0]?.COUNT ?? 0) === 0) {
        return;
      }

      const hasColumn = async (column: string) => {
        const rows: { COUNT: string | number }[] = await runner.query(
          `SELECT COUNT(*) AS COUNT FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
          ['user', column],
        );
        return Number(rows?.[0]?.COUNT ?? 0) > 0;
      };

      if (!(await hasColumn('rahkaranId'))) {
        try {
          await runner.query(
            'ALTER TABLE `user` ADD COLUMN `rahkaranId` INT NULL',
          );
          this.logger.warn(
            'Added missing user.rahkaranId column at startup backstop.',
          );
        } catch (err) {
          if (!(await hasColumn('rahkaranId'))) throw err;
        }
      }

      if (!(await hasColumn('loyalty_member_synced_at'))) {
        try {
          await runner.query(
            'ALTER TABLE `user` ADD COLUMN `loyalty_member_synced_at` DATETIME(6) NULL',
          );
          this.logger.warn(
            'Added missing user.loyalty_member_synced_at column at startup backstop; run pnpm migration:run to record FixUserLoyaltyMemberSyncedAtColumn1809000000000.',
          );
        } catch (err) {
          if (!(await hasColumn('loyalty_member_synced_at'))) throw err;
        }
      }
    } catch (error) {
      this.logger.error(
        `Could not verify/ensure user.loyalty_member_synced_at column (${error instanceof Error ? error.message : String(error)}). Run pnpm migration:run in back/.`,
      );
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  async create(createUserDto: CreateUserDto) {
    const user = this.usersRepository.create(createUserDto);

    try {
      return await this.usersRepository.save(user);
    } catch (error) {
      if (isDuplicateEntryError(error)) {
        const message = String(
          (error as { driverError?: { message?: string }; message?: string })
            ?.driverError?.message ??
            (error as { message?: string })?.message ??
            '',
        ).toLowerCase();

        if (message.includes('email')) {
          throw new BadRequestException('کاربر با این ایمیل وجود دارد');
        }

        if (createUserDto.email && !message.includes('phone')) {
          const existingEmail = await this.findWithEmail(
            createUserDto.email,
          ).catch(() => null);
          if (existingEmail) {
            throw new BadRequestException('کاربر با این ایمیل وجود دارد');
          }
        }

        throw new BadRequestException('کاربر با این شماره تلفن وجود دارد');
      }

      throw error;
    }
  }

  async findWithPhone(phone: string) {
    return await this.usersRepository.findOne({
      where: { phone },
    });
  }

  async findWithEmail(email: string) {
    return await this.usersRepository.findOne({
      where: { email },
    });
  }

  async findAll(query: QueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const qb = this.usersRepository.createQueryBuilder('user');

    // search
    applySearch(qb, query.search, ['user.fullName', 'user.phone']);

    // sort
    applySort(qb, query.sort);

    // pagination
    const { skip, take } = getPagination(page, limit);
    qb.skip(skip).take(take);

    const [data, total] = await qb.getManyAndCount();

    return {
      data,
      pagination: {
        page: page,
        limit: limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: number) {
    const payload = await this.usersRepository.findOne({
      where: { id },
    });
    return payload;
  }

  async updateUser(id: number, updateUserDto: UpdateUserDto, user: any) {
    const isAdmin = Array.isArray(user?.roles) && user.roles.includes('admin');
    if (user?.id !== id && !isAdmin) {
      throw new ForbiddenException('access denied');
    }

    const userEntity = await this.usersRepository.findOne({
      where: { id },
    });

    if (!userEntity) throw new NotFoundException();

    if (updateUserDto.email && updateUserDto.email !== userEntity.email) {
      const existingUser = await this.usersRepository.findOne({
        where: {
          email: updateUserDto.email,
        },
      });

      if (existingUser && existingUser.id !== id) {
        throw new ConflictException('این ایمیل قبلاً استفاده شده است');
      }
    }

    Object.assign(userEntity, updateUserDto);

    return this.usersRepository.save(userEntity);
  }

  async update(id: number, data: Partial<User>): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User with id ${id} not found`);
    }
    Object.assign(user, data);
    return this.usersRepository.save(user);
  }

  async remove(id: number) {
    const user = await this.usersRepository.findOne({
      where: { id },
    });

    if (!user) throw new NotFoundException();

    return this.usersRepository.delete(id);
  }
}

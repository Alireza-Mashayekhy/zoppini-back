import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import {
  applySearch,
  applySort,
  getPagination,
  QueryDto,
} from 'src/common/query';
import { Repository } from 'typeorm';

import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private usersRepository: Repository<User>,
  ) {}

  async create(createUserDto: CreateUserDto) {
    const user = this.usersRepository.create(createUserDto);

    return await this.usersRepository.save(user);
  }

  /**
   * مسیر ساخت کاربر از پنل مدیر قبلاً رمز را بدون hash ذخیره می‌کرد.
   * این متد مخصوص همان مسیر است و همیشه رمز را با bcrypt هش می‌کند.
   *
   * مسیر sign-up عمومی رمز را از قبل هش می‌کند و از create() استفاده
   * می‌کند؛ بنابراین behavior آن تغییر نکرده است.
   */
  async createAdminUser(createUserDto: CreateUserDto) {
    const { code: _code, password, ...rest } = createUserDto;

    if (!password) {
      throw new BadRequestException('رمز عبور الزامی است');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = this.usersRepository.create({
      ...rest,
      password: hashedPassword,
    });

    const savedUser = await this.usersRepository.save(user);

    return this.toSafeUser(savedUser);
  }

  /**
   * فیلد hash رمز هرگز نباید در پاسخ API برگردد.
   * nationalCode و تلفن برای پنل مدیر لازم‌اند و حذف نمی‌شوند.
   */
  toSafeUser(user: User | null): Omit<User, 'password'> | null {
    if (!user) {
      return null;
    }

    const { password: _password, ...safeUser } = user;

    return safeUser;
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
      data: data.map(user => this.toSafeUser(user)),
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

  async updateUser(
    id: number,
    updateUserDto: UpdateUserDto,
    user: any,
    options: { passwordAlreadyHashed?: boolean } = {},
  ) {
    if (user.id !== id && !user.roles.includes('admin')) {
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

    const { password, code: _code, ...rest } = updateUserDto;

    Object.assign(userEntity, rest);

    if (password) {
      userEntity.password = options.passwordAlreadyHashed
        ? password
        : await bcrypt.hash(password, 10);
    }

    const savedUser = await this.usersRepository.save(userEntity);

    return this.toSafeUser(savedUser);
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

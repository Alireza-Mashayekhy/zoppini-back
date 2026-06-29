import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
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

  async update(id: number, updateUserDto: UpdateUserDto, user: any) {
    if (user.id !== id && !user.roles.includes('admin')) {
      throw new ForbiddenException('access denied');
    }

    const userEntity = await this.usersRepository.findOne({
      where: { id },
    });

    if (!userEntity) throw new NotFoundException();

    Object.assign(userEntity, updateUserDto);

    return this.usersRepository.save(userEntity);
  }

  async remove(id: number) {
    const user = await this.usersRepository.findOne({
      where: { id },
    });

    if (!user) throw new NotFoundException();

    return this.usersRepository.delete(id);
  }
}

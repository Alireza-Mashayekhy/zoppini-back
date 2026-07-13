// src/b2b/b2b.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreateB2BRequestDto } from './dto/create-b2b-request.dto';
import { B2BRequest } from './entities/b2b-request.entity';

@Injectable()
export class B2BService {
  constructor(
    @InjectRepository(B2BRequest)
    private b2bRepo: Repository<B2BRequest>,
  ) {}

  async create(dto: CreateB2BRequestDto): Promise<B2BRequest> {
    const request = this.b2bRepo.create(dto);
    return this.b2bRepo.save(request);
  }

  async findAll(): Promise<B2BRequest[]> {
    return this.b2bRepo.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: number): Promise<B2BRequest> {
    const request = await this.b2bRepo.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('درخواست یافت نشد');
    }
    return request;
  }

  // متد update حذف شد (در صورت نیاز می‌توانید برای adminNote اضافه کنید)

  async remove(id: number): Promise<void> {
    const result = await this.b2bRepo.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException('درخواست یافت نشد');
    }
  }
}

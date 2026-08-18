import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreateContactDto } from './dto/create-contact.dto';
import { Contact } from './entities/contact.entity';

@Injectable()
export class ContactService {
  constructor(
    @InjectRepository(Contact)
    private readonly contactRepo: Repository<Contact>,
  ) {}

  // =========================================================
  // CREATE - PUBLIC
  // =========================================================

  async create(dto: CreateContactDto) {
    const contactMessage = this.contactRepo.create({
      name: dto.name.trim(),
      email: dto.email.trim().toLowerCase() || null,
      phone: dto.phone?.trim(),
      message: dto.message?.trim(),
    });

    const saved = await this.contactRepo.save(contactMessage);

    return {
      message: 'پیام شما با موفقیت ارسال شد.',
      data: saved,
    };
  }

  // =========================================================
  // FIND ALL - ADMIN
  // =========================================================

  async findAll() {
    return this.contactRepo.find({
      order: {
        createdAt: 'DESC',
      },
    });
  }

  // =========================================================
  // FIND ONE - ADMIN
  // =========================================================

  async findOne(id: number) {
    const contactMessage = await this.contactRepo.findOne({
      where: {
        id,
      },
    });

    if (!contactMessage) {
      throw new NotFoundException('پیام تماس پیدا نشد.');
    }

    return contactMessage;
  }

  // =========================================================
  // DELETE - ADMIN
  // =========================================================

  async remove(id: number) {
    const contactMessage = await this.findOne(id);

    await this.contactRepo.remove(contactMessage);

    return {
      message: 'پیام با موفقیت حذف شد.',
    };
  }
}

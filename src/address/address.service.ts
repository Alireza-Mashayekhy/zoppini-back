// src/addresses/addresses.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { City } from 'src/locations/entities/city.entity';
import { Province } from 'src/locations/entities/province.entity';
import { Repository } from 'typeorm';

import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { Address } from './entities/address.entity';

@Injectable()
export class AddressesService {
  constructor(
    @InjectRepository(Address)
    private addressRepo: Repository<Address>,
    @InjectRepository(Province)
    private provinceRepo: Repository<Province>,
    @InjectRepository(City)
    private cityRepo: Repository<City>,
  ) {}

  async getAddresses(userId: number): Promise<Address[]> {
    return this.addressRepo.find({
      where: { userId },
      relations: {
        city: true,
        province: true,
      },
      order: { isDefault: 'DESC', createdAt: 'DESC' },
    });
  }

  async getAddress(id: number, userId: number): Promise<Address> {
    const address = await this.addressRepo.findOne({
      where: { id, userId },
      relations: {
        city: true,
        province: true,
      },
    });
    if (!address) {
      throw new NotFoundException('آدرس یافت نشد');
    }
    return address;
  }

  async createAddress(userId: number, dto: CreateAddressDto): Promise<Address> {
    // اعتبارسنجی استان و شهر
    const province = await this.provinceRepo.findOne({
      where: { id: dto.provinceId },
    });
    if (!province) throw new NotFoundException('استان نامعتبر');

    const city = await this.cityRepo.findOne({
      where: { id: dto.cityId, provinceId: dto.provinceId },
    });
    if (!city) throw new NotFoundException('شهر نامعتبر');

    if (dto.isDefault) {
      await this.addressRepo.update({ userId }, { isDefault: false });
    }

    const address = this.addressRepo.create({
      ...dto,
      userId,
    });
    return this.addressRepo.save(address);
  }

  async updateAddress(
    id: number,
    userId: number,
    dto: UpdateAddressDto,
  ): Promise<Address> {
    const address = await this.getAddress(id, userId);

    if (dto.provinceId) {
      const province = await this.provinceRepo.findOne({
        where: { id: dto.provinceId },
      });
      if (!province) throw new NotFoundException('استان نامعتبر');
    }
    if (dto.cityId) {
      const city = await this.cityRepo.findOne({
        where: { id: dto.cityId, provinceId: dto.provinceId },
      });
      if (!city) throw new NotFoundException('شهر نامعتبر');
    }

    if (dto.isDefault) {
      await this.addressRepo.update({ userId }, { isDefault: false });
    }

    Object.assign(address, dto);
    return this.addressRepo.save(address);
  }

  async deleteAddress(id: number, userId: number): Promise<void> {
    const address = await this.getAddress(id, userId);
    await this.addressRepo.remove(address);
  }

  async setDefaultAddress(userId: number, id: number): Promise<Address> {
    await this.addressRepo.update({ userId }, { isDefault: false });
    await this.addressRepo.update({ id, userId }, { isDefault: true });
    return this.getAddress(id, userId);
  }
}

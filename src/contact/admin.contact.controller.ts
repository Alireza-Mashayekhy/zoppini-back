import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';

import { ContactService } from './contact.service';

@Controller('admin/contact')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
export class ContactAdminController {
  constructor(private readonly contactService: ContactService) {}
  @Get()
  findAll() {
    return this.contactService.findAll();
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe)
    id: number,
  ) {
    return this.contactService.findOne(id);
  }

  @Delete(':id')
  remove(
    @Param('id', ParseIntPipe)
    id: number,
  ) {
    return this.contactService.remove(id);
  }
}

import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from 'src/common/guards/auth.guard';

import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @UseGuards(AuthGuard)
  @Get(':id')
  findOne(@Req() req, @Param('id') id: string) {
    if (req.user.id === id) {
      return this.usersService.findOne(+id);
    } else {
      throw new NotFoundException('کاربر یافت نشد');
    }
  }

  @UseGuards(AuthGuard)
  @Patch(':id')
  update(@Param('id') id: number, @Body() dto: UpdateUserDto, @Req() req) {
    return this.usersService.updateUser(id, dto, req.user);
  }
}

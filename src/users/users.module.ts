import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from './entities/user.entity';
import { AdminUsersController } from './users.admin.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UsersController, AdminUsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}

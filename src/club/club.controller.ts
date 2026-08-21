import { Body, Controller, Post } from '@nestjs/common';

import { ClubService } from './club.service';

@Controller('club')
export class ClubController {
  constructor(private readonly clubService: ClubService) {}

  @Post()
  async createInvoice(@Body() body) {
    return this.clubService.registerCustomer(body);
  }
}

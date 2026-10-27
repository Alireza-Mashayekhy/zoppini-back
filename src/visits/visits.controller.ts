import { Controller, GoneException, Post } from '@nestjs/common';
@Controller('visits')
export class VisitsController {
  @Post() track() {
    throw new GoneException('Legacy collector retired');
  }
}

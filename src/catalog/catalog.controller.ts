import { Body, Controller, Get } from '@nestjs/common';

import { CatalogService } from './catalog.service';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get('pages')
  async getPages() {
    return this.catalogService.getPages();
  }
}

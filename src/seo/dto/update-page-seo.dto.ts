import { PartialType } from '@nestjs/swagger';

import { CreatePageSeoDto } from './create-page-seo.dto';

export class UpdatePageSeoDto extends PartialType(CreatePageSeoDto) {}

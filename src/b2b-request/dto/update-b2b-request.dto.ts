import { PartialType } from '@nestjs/swagger';

import { CreateB2BRequestDto } from './create-b2b-request.dto';

export class UpdateB2bRequestDto extends PartialType(CreateB2BRequestDto) {}

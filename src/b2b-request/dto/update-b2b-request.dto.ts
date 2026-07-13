import { PartialType } from '@nestjs/swagger';
import { CreateB2bRequestDto } from './create-b2b-request.dto';

export class UpdateB2bRequestDto extends PartialType(CreateB2bRequestDto) {}

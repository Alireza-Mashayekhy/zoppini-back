import { PartialType } from '@nestjs/swagger';
import { CreateTorobDto } from './create-torob.dto';

export class UpdateTorobDto extends PartialType(CreateTorobDto) {}

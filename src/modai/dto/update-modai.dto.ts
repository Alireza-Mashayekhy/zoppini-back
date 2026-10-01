import { PartialType } from '@nestjs/swagger';
import { CreateModaiDto } from './create-modai.dto';

export class UpdateModaiDto extends PartialType(CreateModaiDto) {}

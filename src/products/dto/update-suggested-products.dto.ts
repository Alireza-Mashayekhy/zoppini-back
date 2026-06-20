import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsNumber } from 'class-validator';

export class UpdateSuggestedProductsDto {
  @ApiProperty({
    type: [Number],
  })
  @IsArray()
  @IsNumber({}, { each: true })
  @Type(() => Number)
  suggestedProductIds: number[];
}

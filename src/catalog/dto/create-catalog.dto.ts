import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class CreateCatalogDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number;
}

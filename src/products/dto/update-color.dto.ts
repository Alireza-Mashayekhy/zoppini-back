import { IsOptional, IsString, Length } from 'class-validator';

export class UpdateColorDto {
  @IsOptional()
  @IsString()
  @Length(1, 50)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(7, 7)
  hexCode?: string;
}

import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsIranMobileField } from 'src/common/decorators/is-iran-mobile.decorator';

export class CreateUserDto {
  @ApiProperty()
  @IsString()
  fullName: string;

  @IsIranMobileField()
  phone: string;

  @ApiProperty()
  @IsEmail()
  email: string | null;

  @ApiProperty()
  @IsString()
  @MinLength(5)
  @MaxLength(5)
  code: string;

  @ApiProperty()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsString() // ← تغییر از @IsDateString() به @IsString()
  birthDate?: string;
}

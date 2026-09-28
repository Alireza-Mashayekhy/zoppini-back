import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateUserDto {
  @ApiProperty()
  @IsString()
  fullName: string;

  @ApiProperty()
  @IsString()
  @MaxLength(11)
  @MinLength(11)
  phone: string;

  @ApiProperty()
  @IsEmail()
  email: string | null;

  @ApiProperty()
  @IsString()
  @MaxLength(5)
  @MinLength(5)
  code: string;

  @ApiProperty()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsString() // ← تغییر از @IsDateString() به @IsString()
  birthDate?: string;
}

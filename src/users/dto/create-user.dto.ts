import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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
  @IsString()
  email: string;

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

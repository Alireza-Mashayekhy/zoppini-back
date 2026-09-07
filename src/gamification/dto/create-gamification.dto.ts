import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class GamificationAnswerDto {
  @ApiProperty({
    example: 1,
    description: `شماره سوال (از 1 تا ${4})`,
  })
  @Type(() => Number)
  @IsInt({ message: 'شماره سوال باید عدد صحیح باشد.' })
  @Min(1, { message: 'شماره سوال باید از ۱ شروع شود.' })
  @Max(4, {
    message: `شماره سوال باید بین ۱ و ${4} باشد.`,
  })
  questionNumber: number;

  @ApiProperty({ example: 3, description: 'شماره گزینه انتخاب‌شده (از 1)' })
  @Type(() => Number)
  @IsInt({ message: 'شماره گزینه باید عدد صحیح باشد.' })
  @Min(1, { message: 'شماره گزینه باید از ۱ شروع شود.' })
  @Max(4, {
    message: `شماره گزینه باید بین ۱ و ${4} باشد.`,
  })
  optionNumber: number;
}

export class CreateGamificationParticipationDto {
  @ApiPropertyOptional({
    example: 'علی محمدی',
    description:
      'نام و نام خانوادگی — می‌توانید به‌جای آن firstName و lastName را بفرستید',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  fullName?: string;

  @ApiPropertyOptional({ example: 'علی', description: 'نام' })
  @IsOptional()
  @IsString()
  @MaxLength(75)
  firstName?: string;

  @ApiPropertyOptional({ example: 'محمدی', description: 'نام خانوادگی' })
  @IsOptional()
  @IsString()
  @MaxLength(75)
  lastName?: string;

  @ApiProperty({
    example: '09123456789',
    description: 'شماره موبایل (09123456789 یا +989123456789 یا ۰۹۱۲۳۴۵۶۷۸۹)',
  })
  @IsString()
  @IsNotEmpty({ message: 'شماره موبایل الزامی است.' })
  @Matches(/^(?:\+?98|0098|0)?9\d{9}$/, {
    message: 'شماره موبایل معتبر نیست.',
  })
  phone: string;

  @ApiProperty({
    example: '1372/05/12',
    description: 'تاریخ تولد به شمسی یا میلادی (1372/05/12 یا 1993-08-03)',
  })
  @IsString()
  @IsNotEmpty({ message: 'تاریخ تولد الزامی است.' })
  @MaxLength(30)
  birthDate: string;

  @ApiProperty({
    type: [GamificationAnswerDto],
    description: 'پاسخ کاربر به سوالات (فقط شماره سوال و شماره گزینه)',
    example: [
      { questionNumber: 1, optionNumber: 3 },
      { questionNumber: 2, optionNumber: 1 },
    ],
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'حداقل به یک سوال باید پاسخ داده شود.' })
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => GamificationAnswerDto)
  answers: GamificationAnswerDto[];
}

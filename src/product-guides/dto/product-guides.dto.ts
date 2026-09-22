import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { GuideMode, GuideOverrideAction, GuideType } from '../guide-enums';

// ============================================================
// جدول سایزبندی
// ============================================================

export class SizeTableColumnDto {
  @ApiPropertyOptional({ description: 'شناسه ستون — برای ستون‌های جدید خالی' })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  id?: number;

  @ApiProperty({
    example: 'L',
    description: 'برچسب سایز — مثل S ، M ، L یا ۴۸',
  })
  @IsString()
  @IsNotEmpty({ message: 'برچسب سایز الزامی است.' })
  @MaxLength(50)
  label: string;
}

export class SizeTableRowDto {
  @ApiPropertyOptional({ description: 'شناسه ردیف — برای ردیف‌های جدید خالی' })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  id?: number;

  @ApiProperty({
    example: 'عرض سینه',
    description: 'نام مشخصه اندازه‌گیری',
  })
  @IsString()
  @IsNotEmpty({ message: 'نام مشخصه اندازه‌گیری الزامی است.' })
  @MaxLength(150)
  label: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'مقدار هر خانه به ترتیب ستون‌ها — مقدار خالی یعنی «اندازه وارد نشده»',
    example: ['52', '55', '58', '61'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  values?: (string | null)[];
}

export class UpsertSizeTableDto {
  @ApiProperty({ example: 'سایزبندی پیراهن کلاسیک' })
  @IsString()
  @IsNotEmpty({ message: 'نام جدول سایزبندی الزامی است.' })
  @MaxLength(150)
  name: string;

  @ApiPropertyOptional({ example: 'سانتیمتر' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  unit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string | null;

  @ApiProperty({ type: [SizeTableColumnDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SizeTableColumnDto)
  columns: SizeTableColumnDto[];

  @ApiProperty({ type: [SizeTableRowDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SizeTableRowDto)
  rows: SizeTableRowDto[];
}

export class DuplicateGuideDto {
  @ApiPropertyOptional({
    description: 'نام نسخه کپی — پیش‌فرض: نام اصلی + (کپی)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;
}

// ============================================================
// راهنمای شست‌وشو
// ============================================================

export class CareInstructionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  id?: number;

  @ApiProperty({ example: 'با آب سرد و برنامه ملایم بشویید.' })
  @IsString()
  @IsNotEmpty({ message: 'متن دستور شست‌وشو الزامی است.' })
  @MaxLength(500)
  text: string;

  @ApiPropertyOptional({
    example: 'wash-30',
    description: 'کلید علامت شست‌وشو (اختیاری)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  iconKey?: string | null;
}

export class UpsertCareGuideDto {
  @ApiProperty({ example: 'شست‌وشوی پیراهن کلاسیک' })
  @IsString()
  @IsNotEmpty({ message: 'نام راهنمای شست‌وشو الزامی است.' })
  @MaxLength(150)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string | null;

  @ApiPropertyOptional({ type: [CareInstructionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CareInstructionDto)
  instructions?: CareInstructionDto[];
}

// ============================================================
// تصاویر روش اندازه‌گیری
// ============================================================

export class UpsertMeasurementGuideDto {
  @ApiProperty({ example: 'روش اندازه‌گیری پیراهن' })
  @IsString()
  @IsNotEmpty({ message: 'نام راهنمای تصویری الزامی است.' })
  @MaxLength(150)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string | null;

  @ApiPropertyOptional({
    example: '[1,3]',
    description: 'شناسه تصاویر قبلی که باید بمانند و به همین ترتیب مرتب شوند',
  })
  @IsOptional()
  @IsString()
  keepImageIds?: string;
}

export class UpdateMeasurementImageDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  caption?: string | null;

  @ApiPropertyOptional({ description: 'ترتیب جدید تصویر در راهنما' })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  order?: number;
}

export class ReorderMeasurementImagesDto {
  @ApiProperty({ example: [3, 1, 2] })
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  imageIds: number[];
}

// ============================================================
// اختصاص راهنما به دسته‌ها و محصولات
// ============================================================

/**
 * فیلدهای `null` یعنی «پاک‌کردن راهنمای این بخش» و فیلدهای ارسال‌نشده
 * یعنی «تغییری اعمال نشود».
 */
export class AssignGuidesDto {
  @ApiPropertyOptional({ type: [Number], description: 'دسته‌های انتخاب‌شده' })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  categoryIds?: number[];

  @ApiPropertyOptional({ type: [Number], description: 'محصولات انتخاب‌شده' })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  productIds?: number[];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sizeTableId?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  careGuideId?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  measurementGuideId?: number | null;

  @ApiPropertyOptional({
    description:
      'اعمال اجباری حتی وقتی تعارض یا هشدار وجود دارد (پیش‌فرض: false)',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  force?: boolean;
}

// ============================================================
// تنظیمات و تغییرات اختصاصی محصول
// ============================================================

export class UpsertProductGuideSettingDto {
  @ApiProperty({ example: 12 })
  @IsInt()
  @Type(() => Number)
  productId: number;

  @ApiPropertyOptional({ enum: GuideMode })
  @IsOptional()
  @IsEnum(GuideMode)
  sizeTableMode?: GuideMode;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sizeTableId?: number | null;

  @ApiPropertyOptional({ enum: GuideMode })
  @IsOptional()
  @IsEnum(GuideMode)
  careGuideMode?: GuideMode;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  careGuideId?: number | null;

  @ApiPropertyOptional({ enum: GuideMode })
  @IsOptional()
  @IsEnum(GuideMode)
  measurementGuideMode?: GuideMode;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  measurementGuideId?: number | null;
}

export class UpsertProductOverrideDto {
  @ApiProperty({ enum: GuideType })
  @IsEnum(GuideType)
  guideType: GuideType;

  @ApiProperty({ enum: GuideOverrideAction })
  @IsEnum(GuideOverrideAction)
  action: GuideOverrideAction;

  @ApiProperty({
    example: 'cell:12:34',
    description:
      'cell:{rowId}:{columnId} | row:{id} | column:{id} | instruction:{id} | image:{id}',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  targetKey: string;

  @ApiPropertyOptional({ description: 'مقدار جدید یا شناسه تصویر جانشین' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  value?: string | null;

  @ApiPropertyOptional({
    description:
      'شناسه راهنمای پایه — اگر ارسال نشود، راهنمای فعلی محصول به‌عنوان پایه ثبت می‌شود',
  })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  baseGuideId?: number | null;
}

export class ApplyAssignmentDto extends AssignGuidesDto {
  @ApiPropertyOptional({ description: 'پیش‌نمایش بدون ذخیره‌سازی' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  preview?: boolean;
}

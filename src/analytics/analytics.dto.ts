import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class EventDto {
  @IsUUID() id: string;
  @IsIn([
    'page_view',
    'product_view',
    'add_to_cart',
    'cart_updated',
    'checkout_started',
  ])
  name: string;
  @IsOptional() @IsInt() @Min(1) product?: number;
  @IsOptional() @IsInt() @Min(1) variant?: number;
  @IsOptional() @Matches(/^[a-zA-Z][a-zA-Z_-]{0,63}$/) source?: string;
  @IsOptional() @Matches(/^[a-zA-Z][a-zA-Z_-]{0,63}$/) medium?: string;
  @IsOptional() @Matches(/^[a-zA-Z][a-zA-Z_-]{0,63}$/) campaign?: string;
  @IsOptional() @Matches(/^(?=.{1,253}$)[a-zA-Z0-9.-]+$/) referrer?: string;
  @IsIn(['mobile', 'tablet', 'desktop']) device: string;
}
export class ConsentDto {
  @IsUUID() id: string;
  @IsIn(['2026-10-27.2']) policy: string;
  @IsBoolean() preferences: boolean;
  @IsBoolean() analytics: boolean;
  @IsBoolean() marketing: boolean;
  @IsIn(['all', 'reject', 'custom']) choice: string;
  @IsBoolean() changed: boolean;
  @IsBoolean() withdrawn: boolean;
  @IsOptional() @IsUUID() oldVisitor?: string;
  @IsOptional() @IsUUID() visitor?: string;
}
export class ReportDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) start: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) end: string;
  @IsOptional() @IsIn(['mobile', 'tablet', 'desktop']) device?: string;
  @IsOptional() @Matches(/^[a-zA-Z][a-zA-Z_-]{0,63}$/) source?: string;
  @IsOptional() @Matches(/^[a-zA-Z][a-zA-Z_-]{0,63}$/) campaign?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) product?: number;
  @IsOptional() @IsUUID() visitor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit = 100;
}

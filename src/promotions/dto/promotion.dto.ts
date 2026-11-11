import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import {
  FreeItemSelection,
  PromotionRewardType,
  PromotionScope,
  PromotionType,
} from '../entities/promotion.entity';

export class CreatePromotionDto {
  @IsString()
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsString()
  internalDescription?: string | null;

  @IsEnum(PromotionType)
  type: PromotionType;

  @IsOptional()
  @IsEnum(PromotionScope)
  scope?: PromotionScope;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @Type(() => Number)
  productIds?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @Type(() => Number)
  categoryIds?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @Type(() => Number)
  excludedProductIds?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @Type(() => Number)
  excludedCategoryIds?: number[];

  @IsEnum(PromotionRewardType)
  rewardType: PromotionRewardType;

  @ValidateIf(dto => dto.rewardType !== PromotionRewardType.FREE_ITEM)
  @IsNumber()
  @Min(0)
  rewardValue?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxDiscountAmount?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  minQuantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minCartValue?: number;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(20)
  pairSize?: number;

  @IsOptional()
  @IsBoolean()
  discountEveryExtraUnit?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  requiredQuantity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  freeQuantity?: number;

  @IsOptional()
  @IsEnum(PromotionScope)
  rewardScope?: PromotionScope | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @Type(() => Number)
  rewardProductIds?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @Type(() => Number)
  rewardCategoryIds?: number[];

  @IsOptional()
  @IsInt()
  suggestedProductId?: number | null;

  @IsOptional()
  @IsInt()
  suggestedCategoryId?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  rewardQuantity?: number;

  @IsOptional()
  @IsEnum(FreeItemSelection)
  freeItemSelection?: FreeItemSelection;

  @IsOptional()
  @IsBoolean()
  autoAddReward?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresCustomerAcceptance?: boolean;

  @IsOptional()
  @IsBoolean()
  removeRewardWhenTriggerRemoved?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsDateString()
  startsAt: string;

  @IsDateString()
  expiresAt: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxTotalUses?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUsesPerCustomer?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxApplicationsPerCart?: number;

  @IsOptional()
  @IsBoolean()
  canStack?: boolean;

  @IsOptional()
  @IsBoolean()
  stackable?: boolean;

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  badgeText?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  customerDescription?: string | null;

  @IsOptional()
  @IsBoolean()
  showBadgeOnProductCard?: boolean;

  @IsOptional()
  @IsBoolean()
  showBadgeOnProductPage?: boolean;

  @IsOptional()
  @IsBoolean()
  showPreCartPopup?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  popupTitle?: string | null;

  @IsOptional()
  @IsString()
  popupDescription?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  popupAcceptLabel?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  popupDismissLabel?: string | null;

  @IsOptional()
  @IsInt()
  popupSuggestedProductId?: number | null;

  @IsOptional()
  @IsInt()
  popupSuggestedCategoryId?: number | null;
}

export class UpdatePromotionDto extends CreatePromotionDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  declare name: string;

  @IsOptional()
  @IsEnum(PromotionType)
  declare type: PromotionType;

  @IsOptional()
  @IsEnum(PromotionRewardType)
  declare rewardType: PromotionRewardType;

  @IsOptional()
  @IsDateString()
  declare startsAt: string;

  @IsOptional()
  @IsDateString()
  declare expiresAt: string;
}

export class ListPromotionsQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(PromotionType)
  type?: PromotionType;

  @IsOptional()
  @IsString()
  status?: 'live' | 'scheduled' | 'expired' | 'inactive' | 'all';
}

/** پیش‌نمایش پروموشن روی یک یا چند محصول */
export class PreviewPromotionDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  @Type(() => Number)
  productIds?: number[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  cartValue?: number;

  /** برای انواع تعداد-محور: چند کالا در سبد باشد */
  @IsOptional()
  @IsInt()
  @Min(0)
  quantity?: number;

  /** تاریخ مرجع (پیش‌فرض: اکنون) */
  @IsOptional()
  @IsDateString()
  now?: string;

  @IsOptional()
  @IsBoolean()
  allowStacking?: boolean;
}

/** وضعیت پذیرش/انتخاب پاداش‌ها از سمت مشتری */
export class PromotionCartStateDto {
  @IsOptional()
  @IsString()
  guestId?: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  acceptedPromotionIds?: number[];

  @IsOptional()
  @IsArray()
  dismissedPromotionIds?: number[];

  @IsOptional()
  @IsArray()
  selectedRewards?: { promotionId: number; productId: number; variantId: number }[];
}

export class AddRewardToCartDto {
  @IsInt()
  @Type(() => Number)
  promotionId: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  variantId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  productId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity?: number;
}

export class SelectCartRewardDto {
  @IsInt()
  @Type(() => Number)
  promotionId: number;

  @IsInt()
  @Type(() => Number)
  variantId: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity?: number;
}

export class RejectCartRewardDto {
  @IsInt()
  @Type(() => Number)
  promotionId: number;
}

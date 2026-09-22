/** نوع راهنما */
export enum GuideType {
  SIZE_TABLE = 'size-table',
  CARE_GUIDE = 'care-guide',
  MEASUREMENT_GUIDE = 'measurement-guide',
}

/** حالت انتخاب راهنما برای یک محصول */
export enum GuideMode {
  /** استفاده از راهنمای دسته محصول */
  INHERIT = 'inherit',
  /** انتخاب راهنمای دیگر برای همین محصول */
  CUSTOM = 'custom',
  /** عدم نمایش این بخش برای این محصول */
  HIDDEN = 'hidden',
}

/** نوع تغییر اختصاصی یک محصول روی راهنمای مشترک */
export enum GuideOverrideAction {
  /** تغییر مقدار یک خانه از جدول */
  CELL_VALUE = 'cell-value',
  /** تغییر متن یک دستور شست‌وشو یا برچسب ردیف/ستون */
  SET_TEXT = 'set-text',
  /** مخفی‌کردن یک ردیف، ستون، خانه، دستور یا تصویر */
  HIDE = 'hide',
  /** تعویض تصویر اندازه‌گیری با تصویر دیگر */
  REPLACE_IMAGE = 'replace-image',
}

import { GuideMode, GuideOverrideAction, GuideType } from './guide-enums';

export interface SizeTableColumnDefinition {
  id: number;
  label: string;
}

export interface SizeTableRowDefinition {
  id: number;
  label: string;
  cells: { columnId: number; value: string | null }[];
}

export interface SizeTableDefinition {
  id: number;
  name: string;
  unit: string;
  notes: string | null;
  columns: SizeTableColumnDefinition[];
  rows: SizeTableRowDefinition[];
}

export interface CareGuideDefinition {
  id: number;
  name: string;
  notes: string | null;
  instructions: { id: number; text: string; iconKey: string | null }[];
}

export interface MeasurementImageDefinition {
  id: number;
  file: string;
  caption: string | null;
}

export interface MeasurementGuideDefinition {
  id: number;
  name: string;
  notes: string | null;
  images: MeasurementImageDefinition[];
}

export interface OverrideRecord {
  id: number;
  guideType: GuideType;
  action: GuideOverrideAction;
  targetKey: string;
  value: string | null;
  baseGuideId: number | null;
}

/**
 * راهنمای هر دسته برای هر یک از سه نوع — انتخاب‌ها مستقل‌اند، پس هر دسته
 * می‌تواند مثلاً جدول سایز اختصاصی ولی راهنمای شست‌وشوی مشترک داشته باشد.
 */
export interface CategoryGuideCandidate {
  categoryId: number;
  categoryName?: string;
  sizeTableId?: number | null;
  careGuideId?: number | null;
  measurementGuideId?: number | null;
}

export interface ProductGuideSettingInput {
  sizeTableMode: GuideMode;
  sizeTableId: number | null;
  careGuideMode: GuideMode;
  careGuideId: number | null;
  measurementGuideMode: GuideMode;
  measurementGuideId: number | null;
}

export interface ResolveProductGuidesInput {
  categories: CategoryGuideCandidate[];
  setting: ProductGuideSettingInput | null;
  sizeTables: SizeTableDefinition[];
  careGuides: CareGuideDefinition[];
  measurementGuides: MeasurementGuideDefinition[];
  /** همه تصاویر اندازه‌گیری سیستم — برای جایگزینی تصویر */
  measurementImages?: MeasurementImageDefinition[];
  overrides?: OverrideRecord[];
}

export interface GuideConflict {
  type: GuideType;
  guideIds: number[];
  categories: { categoryId: number; categoryName?: string; guideId: number }[];
}

export interface PendingOverrideReview {
  id: number;
  type: GuideType;
  action: GuideOverrideAction;
  targetKey: string;
  value: string | null;
  baseGuideId: number | null;
  currentGuideId: number | null;
  label: string;
}

export interface ResolvedSizeTable {
  id: number;
  name: string;
  unit: string;
  notes: string | null;
  columns: { id: number; label: string; overridden: boolean }[];
  rows: {
    id: number;
    label: string;
    overridden: boolean;
    values: {
      columnId: number;
      value: string | null;
      overridden: boolean;
    }[];
  }[];
}

export interface ResolvedCareGuide {
  id: number;
  name: string;
  notes: string | null;
  instructions: {
    id: number;
    text: string;
    iconKey: string | null;
    overridden: boolean;
  }[];
}

export interface ResolvedMeasurementGuide {
  id: number;
  name: string;
  notes: string | null;
  images: {
    id: number;
    file: string;
    caption: string | null;
    overridden: boolean;
  }[];
}

export interface ResolvedProductGuides {
  sizeTable: ResolvedSizeTable | null;
  careGuide: ResolvedCareGuide | null;
  measurementGuide: ResolvedMeasurementGuide | null;
  /** انواعی که برای این محصول مخفی شده‌اند */
  hidden: GuideType[];
  /** تعارض چند دسته‌ای — تا ادمین انتخاب درست را انجام دهد */
  conflicts: GuideConflict[];
  /** تغییرات اختصاصی که راهنمای پایه‌شان عوض شده و نیاز به بازبینی دارند */
  pendingReview: PendingOverrideReview[];
  /** تغییرات اختصاصی که هدفشان (ردیف/ستون/دستور/تصویر) دیگر وجود ندارد */
  staleOverrides: PendingOverrideReview[];
  /** راهنماهایی که بایگانی شده‌اند و استفاده نشده‌اند */
  archivedGuides: GuideType[];
}

interface ResolvedSource {
  guideId: number | null;
  hidden: boolean;
  conflict?: GuideConflict;
  archived: boolean;
}

const TYPE_KEYS: GuideType[] = [
  GuideType.SIZE_TABLE,
  GuideType.CARE_GUIDE,
  GuideType.MEASUREMENT_GUIDE,
];

export function resolveProductGuides(
  input: ResolveProductGuidesInput,
): ResolvedProductGuides {
  const sizeTable = resolveSizeTableGuide(input);
  const careGuide = resolveCareGuide(input);
  const measurementGuide = resolveMeasurementGuide(input);

  const overrides = input.overrides ?? [];

  const resolvedByType: Record<GuideType, number | null> = {
    [GuideType.SIZE_TABLE]: sizeTable?.id ?? null,
    [GuideType.CARE_GUIDE]: careGuide?.id ?? null,
    [GuideType.MEASUREMENT_GUIDE]: measurementGuide?.id ?? null,
  };

  const { pendingReview, staleOverrides } = classifyOverrides(
    overrides,
    resolvedByType,
    input,
  );

  const hidden: GuideType[] = [];
  const conflicts: GuideConflict[] = [];
  const archivedGuides: GuideType[] = [];

  for (const type of TYPE_KEYS) {
    const source = resolveSource(type, input);

    if (source.hidden) hidden.push(type);
    if (source.conflict) conflicts.push(source.conflict);
    if (source.archived) archivedGuides.push(type);
  }

  return {
    sizeTable,
    careGuide,
    measurementGuide,
    hidden,
    conflicts,
    pendingReview,
    staleOverrides,
    archivedGuides,
  };
}

export function resolveSource(
  type: GuideType,
  input: ResolveProductGuidesInput,
): ResolvedSource {
  const setting = input.setting;

  const mode = setting ? modeOf(type, setting) : GuideMode.INHERIT;

  if (mode === GuideMode.HIDDEN) {
    return { guideId: null, hidden: true, archived: false };
  }

  if (mode === GuideMode.CUSTOM) {
    const explicitId = setting ? guideIdOf(type, setting) : null;

    return {
      guideId: explicitId,
      hidden: !explicitId,
      archived: explicitId ? isArchived(type, explicitId, input) : false,
    };
  }

  const candidates: {
    categoryId: number;
    categoryName?: string;
    guideId: number;
  }[] = [];

  for (const category of input.categories ?? []) {
    const guideId = categoryGuideId(type, category);

    if (!guideId) continue;

    candidates.push({
      categoryId: category.categoryId,
      categoryName: category.categoryName,
      guideId,
    });
  }

  const guideIds = [...new Set(candidates.map(candidate => candidate.guideId))];

  if (guideIds.length === 0) {
    return { guideId: null, hidden: true, archived: false };
  }

  if (guideIds.length === 1) {
    const guideId = guideIds[0];

    return {
      guideId,
      hidden: isArchived(type, guideId, input),
      archived: isArchived(type, guideId, input),
    };
  }

  /**
   * دسته‌های محصول راهنماهای متفاوتی دارند؛ سیستم نباید تصادفی یکی را انتخاب
   * کند. تعارض گزارش می‌شود و تا زمانی که ادمین انتخاب نکند، این بخش نمایش
   * داده نمی‌شود.
   */
  return {
    guideId: null,
    hidden: true,
    archived: false,
    conflict: {
      type,
      guideIds,
      categories: candidates,
    },
  };
}

function isArchived(
  type: GuideType,
  guideId: number,
  input: ResolveProductGuidesInput,
): boolean {
  const guide = findDefinition(type, guideId, input) as
    { isArchived?: boolean } | undefined;

  return Boolean(guide?.isArchived);
}

function findDefinition(
  type: GuideType,
  guideId: number,
  input: ResolveProductGuidesInput,
): unknown {
  if (type === GuideType.SIZE_TABLE) {
    return input.sizeTables.find(item => item.id === guideId);
  }

  if (type === GuideType.CARE_GUIDE) {
    return input.careGuides.find(item => item.id === guideId);
  }

  return input.measurementGuides.find(item => item.id === guideId);
}

function modeOf(type: GuideType, setting: ProductGuideSettingInput): GuideMode {
  if (type === GuideType.SIZE_TABLE) return setting.sizeTableMode;
  if (type === GuideType.CARE_GUIDE) return setting.careGuideMode;

  return setting.measurementGuideMode;
}

function guideIdOf(
  type: GuideType,
  setting: ProductGuideSettingInput,
): number | null {
  if (type === GuideType.SIZE_TABLE) return setting.sizeTableId;
  if (type === GuideType.CARE_GUIDE) return setting.careGuideId;

  return setting.measurementGuideId;
}

function categoryGuideId(
  type: GuideType,
  category: CategoryGuideCandidate,
): number | null {
  if (type === GuideType.SIZE_TABLE) return category.sizeTableId ?? null;
  if (type === GuideType.CARE_GUIDE) return category.careGuideId ?? null;

  return category.measurementGuideId ?? null;
}

// ============================================================
// جدول سایزبندی
// ============================================================

function resolveSizeTableGuide(
  input: ResolveProductGuidesInput,
): ResolvedSizeTable | null {
  const source = resolveSource(GuideType.SIZE_TABLE, input);

  if (!source.guideId) return null;

  const definition = input.sizeTables.find(
    table => table.id === source.guideId,
  );

  if (!definition) return null;

  const overrides = usableOverrides(input, GuideType.SIZE_TABLE, definition.id);

  const columns = [...definition.columns]
    .map(column => {
      const override = overrides.find(
        item =>
          item.action === GuideOverrideAction.SET_TEXT &&
          item.targetKey === `column:${column.id}`,
      );

      return {
        id: column.id,
        label: override?.value ?? column.label,
        overridden: Boolean(override),
      };
    })
    .filter(
      column =>
        !overrides.some(
          item =>
            item.action === GuideOverrideAction.HIDE &&
            item.targetKey === `column:${column.id}`,
        ),
    );

  const visibleColumnIds = new Set(columns.map(column => column.id));

  const rows = [...definition.rows]
    .filter(
      row =>
        !overrides.some(
          item =>
            item.action === GuideOverrideAction.HIDE &&
            item.targetKey === `row:${row.id}`,
        ),
    )
    .map(row => {
      const labelOverride = overrides.find(
        item =>
          item.action === GuideOverrideAction.SET_TEXT &&
          item.targetKey === `row:${row.id}`,
      );

      const values = columns.map(column => {
        const targetKey = `cell:${row.id}:${column.id}`;

        const cellOverride = overrides.find(
          item =>
            item.action === GuideOverrideAction.CELL_VALUE &&
            item.targetKey === targetKey,
        );

        const hideOverride = overrides.find(
          item =>
            item.action === GuideOverrideAction.HIDE &&
            item.targetKey === targetKey,
        );

        const base = row.cells?.find(cell => cell.columnId === column.id);

        /** تغییر اختصاصی با مقدار خالی یعنی «اندازه وارد نشده»، نه صفر */
        const value = hideOverride
          ? null
          : cellOverride
            ? (cellOverride.value ?? null)
            : (base?.value ?? null);

        return {
          columnId: column.id,
          value,
          overridden: Boolean(cellOverride || hideOverride),
        };
      });

      return {
        id: row.id,
        label: labelOverride?.value ?? row.label,
        overridden: Boolean(labelOverride),
        values: values.filter(value => visibleColumnIds.has(value.columnId)),
      };
    });

  return {
    id: definition.id,
    name: definition.name,
    unit: definition.unit,
    notes: definition.notes,
    columns,
    rows,
  };
}

// ============================================================
// راهنمای شست‌وشو
// ============================================================

function resolveCareGuide(
  input: ResolveProductGuidesInput,
): ResolvedCareGuide | null {
  const source = resolveSource(GuideType.CARE_GUIDE, input);

  if (!source.guideId) return null;

  const definition = input.careGuides.find(
    guide => guide.id === source.guideId,
  );

  if (!definition) return null;

  const overrides = usableOverrides(input, GuideType.CARE_GUIDE, definition.id);

  const instructions = [...definition.instructions]
    .filter(
      instruction =>
        !overrides.some(
          item =>
            item.action === GuideOverrideAction.HIDE &&
            item.targetKey === `instruction:${instruction.id}`,
        ),
    )
    .map(instruction => {
      const textOverride = overrides.find(
        item =>
          item.action === GuideOverrideAction.SET_TEXT &&
          item.targetKey === `instruction:${instruction.id}`,
      );

      return {
        id: instruction.id,
        text: textOverride?.value ?? instruction.text,
        iconKey: instruction.iconKey,
        overridden: Boolean(textOverride),
      };
    });

  return {
    id: definition.id,
    name: definition.name,
    notes: definition.notes,
    instructions,
  };
}

// ============================================================
// راهنمای تصویری اندازه‌گیری
// ============================================================

function resolveMeasurementGuide(
  input: ResolveProductGuidesInput,
): ResolvedMeasurementGuide | null {
  const source = resolveSource(GuideType.MEASUREMENT_GUIDE, input);

  if (!source.guideId) return null;

  const definition = input.measurementGuides.find(
    guide => guide.id === source.guideId,
  );

  if (!definition) return null;

  const overrides = usableOverrides(
    input,
    GuideType.MEASUREMENT_GUIDE,
    definition.id,
  );

  const allImages = input.measurementImages ?? definition.images;

  const images = [...definition.images]
    .filter(
      image =>
        !overrides.some(
          item =>
            item.action === GuideOverrideAction.HIDE &&
            item.targetKey === `image:${image.id}`,
        ),
    )
    .map(image => {
      const replaceOverride = overrides.find(
        item =>
          item.action === GuideOverrideAction.REPLACE_IMAGE &&
          item.targetKey === `image:${image.id}`,
      );

      const replacementId = replaceOverride?.value
        ? Number(replaceOverride.value)
        : null;

      const replacement = replacementId
        ? allImages.find(item => item.id === replacementId)
        : undefined;

      if (!replacement) {
        return {
          id: image.id,
          file: image.file,
          caption: image.caption,
          overridden: false,
        };
      }

      return {
        id: image.id,
        file: replacement.file,
        caption: replacement.caption ?? image.caption,
        overridden: true,
      };
    });

  return {
    id: definition.id,
    name: definition.name,
    notes: definition.notes,
    images,
  };
}

// ============================================================
// دسته‌بندی استثناها
// ============================================================

/** فقط استثناهایی که روی همین نسخه از راهنما ثبت شده‌اند اعمال می‌شوند */
function usableOverrides(
  input: ResolveProductGuidesInput,
  type: GuideType,
  guideId: number,
): OverrideRecord[] {
  return (input.overrides ?? []).filter(
    override =>
      override.guideType === type &&
      (override.baseGuideId === null || override.baseGuideId === guideId),
  );
}

function classifyOverrides(
  overrides: OverrideRecord[],
  resolvedByType: Record<GuideType, number | null>,
  input: ResolveProductGuidesInput,
): {
  pendingReview: PendingOverrideReview[];
  staleOverrides: PendingOverrideReview[];
} {
  const pendingReview: PendingOverrideReview[] = [];
  const staleOverrides: PendingOverrideReview[] = [];

  for (const override of overrides) {
    const currentGuideId = resolvedByType[override.guideType] ?? null;

    const base = {
      id: override.id,
      type: override.guideType,
      action: override.action,
      targetKey: override.targetKey,
      value: override.value,
      baseGuideId: override.baseGuideId,
      currentGuideId,
    };

    /**
     * راهنمای پایه عوض شده است — تغییر اختصاصی به راهنمای جدید منتقل نمی‌شود
     * و ادمین باید بازبینی کند.
     */
    if (
      override.baseGuideId !== null &&
      currentGuideId !== null &&
      override.baseGuideId !== currentGuideId
    ) {
      pendingReview.push({
        ...base,
        label: describeOverride(input, override, override.baseGuideId),
      });

      continue;
    }

    /** ردیف/ستون/دستور/تصویر هدف دیگر وجود ندارد */
    if (!isTargetStillValid(input, override, currentGuideId)) {
      staleOverrides.push({
        ...base,
        label: describeOverride(input, override, currentGuideId),
      });
    }
  }

  return { pendingReview, staleOverrides };
}

function isTargetStillValid(
  input: ResolveProductGuidesInput,
  override: OverrideRecord,
  guideId: number | null,
): boolean {
  if (!guideId) return false;

  const parts = override.targetKey.split(':');

  const kind = parts[0];
  const id = Number(parts[1]);

  if (override.guideType === GuideType.SIZE_TABLE) {
    const table = input.sizeTables.find(item => item.id === guideId);

    if (!table) return false;

    if (kind === 'row') {
      return table.rows.some(row => row.id === id);
    }

    if (kind === 'column') {
      return table.columns.some(column => column.id === id);
    }

    if (kind === 'cell') {
      const columnId = Number(parts[2]);

      return (
        table.rows.some(row => row.id === id) &&
        table.columns.some(column => column.id === columnId)
      );
    }

    return false;
  }

  if (override.guideType === GuideType.CARE_GUIDE) {
    const guide = input.careGuides.find(item => item.id === guideId);

    return Boolean(guide?.instructions.some(item => item.id === id));
  }

  const guide = input.measurementGuides.find(item => item.id === guideId);

  if (!guide?.images.some(image => image.id === id)) return false;

  if (override.action === GuideOverrideAction.REPLACE_IMAGE) {
    const replacementId = override.value ? Number(override.value) : null;

    const allImages = input.measurementImages ?? guide.images;

    return Boolean(
      replacementId && allImages.some(i => i.id === replacementId),
    );
  }

  return true;
}

/** توضیح خوانا برای نمایش در پنل */
export function describeOverride(
  input: ResolveProductGuidesInput,
  override: OverrideRecord,
  guideId: number | null,
): string {
  const parts = override.targetKey.split(':');
  const kind = parts[0];
  const id = Number(parts[1]);

  if (override.guideType === GuideType.SIZE_TABLE && guideId) {
    const table = input.sizeTables.find(item => item.id === guideId);

    if (!table) return override.targetKey;

    if (kind === 'cell') {
      const columnId = Number(parts[2]);

      const row = table.rows.find(item => item.id === id);
      const column = table.columns.find(item => item.id === columnId);

      return `${row?.label ?? id} — سایز ${column?.label ?? columnId}`;
    }

    if (kind === 'row') {
      return `ردیف ${table.rows.find(item => item.id === id)?.label ?? id}`;
    }

    if (kind === 'column') {
      return `ستون ${table.columns.find(item => item.id === id)?.label ?? id}`;
    }

    return override.targetKey;
  }

  if (override.guideType === GuideType.CARE_GUIDE && guideId) {
    const guide = input.careGuides.find(item => item.id === guideId);

    const instruction = guide?.instructions.find(item => item.id === id);

    return instruction?.text ?? `دستور ${id}`;
  }

  if (guideId) {
    const guide = input.measurementGuides.find(item => item.id === guideId);

    const image = guide?.images.find(item => item.id === id);

    return image?.caption ?? image?.file ?? `تصویر ${id}`;
  }

  return override.targetKey;
}

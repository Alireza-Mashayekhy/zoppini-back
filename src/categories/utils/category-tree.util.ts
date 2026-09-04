/**
 * ابزار کار با درخت دسته‌بندی‌ها.
 *
 * رابطهٔ والد/فرزند در انتیتهٔ Category با ستون `parentId` ساخته شده که نوعش
 * `string | null` است (مقدار در دیتابیس به‌صورت varchar ذخیره می‌شود)، پس
 * مقایسهٔ آن با کلید عددی در SQL به تبدیل نوع ضمنی می‌افتد و ایندکس را از کار
 * می‌اندازد. به همین دلیل پیمایش درخت اینجا و در حافظه انجام می‌شود؛ تعداد
 * دسته‌بندی‌ها هم آن‌قدر کوچک است که این کار به‌صرفه باشد.
 */

type CategoryNode = {
  id: number;
  parentId?: string | number | null;
};

/** تبدیل parentId به شناسهٔ عددی معتبر؛ ریشه‌ها و مقادیر خراب 0 برمی‌گردانند */
function toParentId(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const parentId = Number(value);

  return Number.isFinite(parentId) && parentId > 0 ? parentId : 0;
}

/**
 * شناسهٔ خودِ دسته‌بندی‌های داده‌شده به‌همراه شناسهٔ همهٔ زیردسته‌هایشان
 * (در هر عمق) برگردانده می‌شود.
 *
 * مثال: اگر «کفش» والد «کفش مردانه» باشد و «کفش مردانه» والد «کفش ورزشی»،
 * آن‌گاه ورودی `[کفش]` خروجی `[کفش, کفش مردانه, کفش ورزشی]` می‌دهد.
 *
 * شناسه‌های نامعتبر (NaN/منفی) حذف می‌شوند و در برابر حلقه در داده‌ها
 * (دسته‌ای که والدِ خودش یا اجدادش باشد) مقاوم است.
 */
export function collectCategoryIdsWithDescendants(
  rootIds: number[],
  categories: CategoryNode[],
): number[] {
  const roots = [
    ...new Set(rootIds.filter(id => Number.isFinite(id) && id > 0)),
  ];

  if (!roots.length) {
    return [];
  }

  const childrenByParent = new Map<number, number[]>();

  for (const category of categories) {
    const parentId = toParentId(category?.parentId);

    if (!parentId || parentId === category.id) {
      continue;
    }

    const siblings = childrenByParent.get(parentId);

    if (siblings) {
      siblings.push(category.id);
    } else {
      childrenByParent.set(parentId, [category.id]);
    }
  }

  const collected = new Set<number>();
  const queue: number[] = [...roots];

  while (queue.length) {
    const current = queue.shift() as number;

    // اگر پیش‌تر دیده شده، ادامهٔ پیمایش یعنی حلقه در داده‌ها
    if (collected.has(current)) {
      continue;
    }

    collected.add(current);

    for (const childId of childrenByParent.get(current) ?? []) {
      if (!collected.has(childId)) {
        queue.push(childId);
      }
    }

    // ترمز اضطراری برای دادهٔ خراب (حلقهٔ والد/فرزند بین چند دسته)
    if (collected.size > categories.length + roots.length) {
      break;
    }
  }

  return [...collected];
}

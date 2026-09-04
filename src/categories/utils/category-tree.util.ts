type CategoryNode = {
  id: number;
  parentId?: string | number | null;
};

function toParentId(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const parentId = Number(value);

  return Number.isFinite(parentId) && parentId > 0 ? parentId : 0;
}

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

    if (collected.has(current)) {
      continue;
    }

    collected.add(current);

    for (const childId of childrenByParent.get(current) ?? []) {
      if (!collected.has(childId)) {
        queue.push(childId);
      }
    }

    if (collected.size > categories.length + roots.length) {
      break;
    }
  }

  return [...collected];
}

import { Brackets, ObjectLiteral, SelectQueryBuilder } from 'typeorm';

/**
 * کاراکترهایی که در جست‌وجو نادیده گرفته می‌شوند.
 *
 * این‌ها هم از عبارت جست‌وجوی کاربر حذف می‌شوند و هم از مقدار ستون‌ها،
 * تا مثلاً «کت تک» و «کت‌تک» (با نیم‌فاصله) یک نتیجه بدهند.
 */
const IGNORED_CHARS = [
  ' ',
  '\t',
  '\n',
  '\r',
  '\u00a0', // نیم‌فاصله لاتین (NBSP)
  '\u200c', // نیم‌فاصله فارسی (ZWNJ)
  '\u200d', // ZWJ
  '\u200e', // LRM
  '\u200f', // RLM
  '\u0640', // کشیده (ـ)
];

/**
 * کاراکترهایی که در حالت «فاصله‌محور» حذف می‌شوند (کشیده)، چون جای فاصله
 * نمی‌نشینند.
 */
const REMOVED_CHARS = ['\u0640'];

/**
 * کاراکترهایی که معادل فاصله در نظر گرفته می‌شوند.
 *
 * نیم‌فاصله فارسی (ZWNJ) هم باید مثل فاصله دیده شود؛ چون «کت‌شلوار» و
 * «کت شلوار» برای کاربر یک معنی دارند.
 */
const SPACE_LIKE_CHARS = [
  '\t',
  '\n',
  '\r',
  '\u00a0', // NBSP
  '\u200b', // ZWSP
  '\u200c', // ZWNJ
  '\u200d', // ZWJ
  '\u200e', // LRM
  '\u200f', // RLM
];

/**
 * معادل‌سازی حروف عربی/فارسی؛ چون بسته به کیبورد کاربر،
 * ممکن است «ي/ك» عربی تایپ شود در حالی که در دیتابیس «ی/ک» فارسی است.
 */
const EQUIVALENT_CHARS: [from: string, to: string][] = [
  ['\u0643', 'ک'], // ك عربی
  ['\u064a', 'ی'], // ي عربی
  ['\u0649', 'ی'], // ى (الف مقصوره)
  ['\u0623', 'ا'], // أ
  ['\u0625', 'ا'], // إ
  ['\u0629', 'ه'], // ة (تاء مربوطه)
];

/** نام پارامترهای تزریق‌شده برای رتبه‌بندی نتایج جست‌وجو */
const RELEVANCE_PARAMS = {
  exact: 'searchRankExact',
  wordStart: 'searchRankWordStart',
  wordMiddle: 'searchRankWordMiddle',
  wordEnd: 'searchRankWordEnd',
  prefix: 'searchRankPrefix',
  contains: 'searchRankContains',
} as const;

export interface ParsedSearchTerm {
  /** عبارت با فاصله‌های یکسان‌سازی‌شده (برای تطبیق کلمه‌ای) */
  spaced: string;
  /** عبارت فشرده و بدون فاصله (برای تطبیق درون کلمه) */
  compact: string;
  /** کلمه‌های عبارت (فشرده و یکتا) */
  tokens: string[];
  /** آیا عبارت خالی است؟ */
  isEmpty: boolean;
}

const EMPTY_SEARCH_TERM: ParsedSearchTerm = {
  spaced: '',
  compact: '',
  tokens: [],
  isEmpty: true,
};

/** یکسان‌سازی حروف (ي/ك عربی و ...). */
function applyEquivalentChars(value: string): string {
  let result = value;

  for (const [from, to] of EQUIVALENT_CHARS) {
    result = result.split(from).join(to);
  }

  return result;
}

/**
 * تجزیه عبارت جست‌وجو به دو شکل:
 *
 * - `spaced`: فاصله‌های نامرئی به فاصله تبدیل می‌شوند («کت‌شلوار» → «کت شلوار»)
 *   تا بتوان تطبیق «کلمه‌ای» انجام داد.
 * - `compact`: همه‌ی فاصله‌ها حذف می‌شوند («کت شلوار» → «کتشلوار») تا
 *   تفاوت فاصله/نیم‌فاصله در تطبیق اثری نداشته باشد.
 * - `tokens`: کلمه‌های جدا (برای جست‌وجوی چندکلمه‌ای فارغ از ترتیب).
 */
export function parseSearchTerm(search: unknown): ParsedSearchTerm {
  const raw =
    typeof search === 'string'
      ? search
      : typeof search === 'number'
        ? search.toString()
        : '';

  if (!raw) {
    return EMPTY_SEARCH_TERM;
  }

  let spaced = raw;

  for (const char of REMOVED_CHARS) {
    spaced = spaced.split(char).join('');
  }

  for (const char of SPACE_LIKE_CHARS) {
    spaced = spaced.split(char).join(' ');
  }

  spaced = applyEquivalentChars(spaced).replace(/\s+/g, ' ').trim();

  if (!spaced) {
    return EMPTY_SEARCH_TERM;
  }

  const compact = spaced.split(' ').join('');
  const tokens = Array.from(new Set(spaced.split(' ').filter(Boolean)));

  return { spaced, compact, tokens, isEmpty: false };
}

/**
 * یکسان‌سازی متن (حذف فاصله‌ها/کاراکترهای نامرئی + معادل‌سازی حروف).
 */
function normalizeText(value: string): string {
  let term = value;

  for (const char of IGNORED_CHARS) {
    term = term.split(char).join('');
  }

  for (const [from, to] of EQUIVALENT_CHARS) {
    term = term.split(from).join(to);
  }

  return term.trim();
}

/**
 * یکسان‌سازی عبارت جست‌وجوی کاربر (trim + حذف فاصله‌ها + معادل‌سازی حروف).
 */
export function normalizeSearchTerm(search: unknown): string {
  if (typeof search === 'string') {
    return normalizeText(search);
  }

  if (typeof search === 'number') {
    return normalizeText(search.toString());
  }

  return '';
}

/**
 * همان یکسان‌سازی بالا، ولی به شکل عبارت SQL تا سمت دیتابیس هم
 * با همان قاعده مقایسه شود (وگرنه جست‌وجوی «کت تک» به «کت‌تک» نمی‌خورد).
 */
export function buildNormalizedColumnExpression(field: string): string {
  let expression = field;

  for (const char of IGNORED_CHARS) {
    expression = `REPLACE(${expression}, '${char}', '')`;
  }

  for (const [from, to] of EQUIVALENT_CHARS) {
    expression = `REPLACE(${expression}, '${from}', '${to}')`;
  }

  return expression;
}

/**
 * نسخه‌ی «فاصله‌محور» عبارت ستون: فاصله‌ها و نیم‌فاصله‌ها یکسان می‌شوند اما
 * حذف نمی‌شوند؛ برای تشخیص این‌که عبارت جست‌وجو یک «کلمه‌ی کامل» در عنوان
 * است یا نه (مثلاً «شلوار» در «شلوار پارچه‌ای» در برابر «کت شلوار»).
 */
export function buildSpacedColumnExpression(field: string): string {
  let expression = `COALESCE(${field}, '')`;

  for (const char of REMOVED_CHARS) {
    expression = `REPLACE(${expression}, '${char}', '')`;
  }

  for (const char of SPACE_LIKE_CHARS) {
    expression = `REPLACE(${expression}, '${char}', ' ')`;
  }

  for (const [from, to] of EQUIVALENT_CHARS) {
    expression = `REPLACE(${expression}, '${from}', '${to}')`;
  }

  return `TRIM(${expression})`;
}

/**
 * عبارت SQL امتیاز «مرتبط بودن» بر اساس محل قرار گرفتن عبارت در یک ستون
 * (عدد کوچک‌تر = مرتبط‌تر):
 *
 * 0. عنوان دقیقاً همان عبارت است
 * 1. عنوان با همان عبارت شروع می‌شود («شلوار پارچه‌ای» برای «شلوار»)
 * 2. عبارت یک کلمه‌ی کامل در عنوان است («کت شلوار» برای «شلوار»)
 * 3. عبارت از ابتدای یک کلمه شروع می‌شود («شلوارک» برای «شلوار»)
 * 4. عبارت داخل یک کلمه آمده است («کت‌شلواری» برای «شلوار»)
 * 5. عبارت در این ستون نیست (فقط در slug/کد آمده)
 *
 * پارامترهایش با `addSearchRelevanceOrder` مقداردهی می‌شوند.
 */
export function buildSearchRelevanceExpression(field: string): string {
  const spaced = buildSpacedColumnExpression(field);
  const compact = buildNormalizedColumnExpression(field);

  return `(CASE
    WHEN ${spaced} = :${RELEVANCE_PARAMS.exact} THEN 0
    WHEN ${spaced} LIKE :${RELEVANCE_PARAMS.wordStart} THEN 1
    WHEN ${spaced} LIKE :${RELEVANCE_PARAMS.wordMiddle} THEN 2
    WHEN ${spaced} LIKE :${RELEVANCE_PARAMS.wordEnd} THEN 2
    WHEN ${compact} LIKE :${RELEVANCE_PARAMS.prefix} THEN 3
    WHEN ${compact} LIKE :${RELEVANCE_PARAMS.contains} THEN 4
    ELSE 5
  END)`;
}

interface AddSearchRelevanceOrderOptions {
  /** ستونی که مبنای رتبه‌بندی است (معمولاً عنوان) */
  rankField: string;
  /** نام ستون محاسبه‌شده در SELECT */
  alias?: string;
  /** اگر true باشد، رتبه‌بندی اولین معیار مرتب‌سازی می‌شود */
  primary?: boolean;
}

/**
 * اضافه کردن مرتب‌سازی بر اساس مرتبط بودن نتیجه با عبارت جست‌وجو.
 *
 * نکته‌ی مهم: امتیاز به شکل یک ستون محاسبه‌شده با alias به SELECT اضافه
 * می‌شود و ORDER BY روی همان alias انجام می‌گیرد؛ چون TypeORM در حالت
 * `take/skip` همراه با join، کوئری را داخل یک ساب‌کوئری با `DISTINCT`
 * می‌برد و در آن حالت ORDER BY باید حتماً روی یک ستون موجود در SELECT
 * باشد (وگرنه MySQL خطای «incompatible with DISTINCT» می‌دهد).
 */
export function addSearchRelevanceOrder<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  search: unknown,
  {
    rankField,
    alias = 'search_rank',
    primary = true,
  }: AddSearchRelevanceOrderOptions,
) {
  const term = parseSearchTerm(search);

  if (term.isEmpty || !rankField) {
    return qb;
  }

  qb.setParameters({
    [RELEVANCE_PARAMS.exact]: term.spaced,
    [RELEVANCE_PARAMS.wordStart]: `${term.spaced} %`,
    [RELEVANCE_PARAMS.wordMiddle]: `% ${term.spaced} %`,
    [RELEVANCE_PARAMS.wordEnd]: `% ${term.spaced}`,
    [RELEVANCE_PARAMS.prefix]: `${term.compact}%`,
    [RELEVANCE_PARAMS.contains]: `%${term.compact}%`,
  });

  qb.addSelect(buildSearchRelevanceExpression(rankField), alias);

  if (primary) {
    qb.orderBy(alias, 'ASC');
  } else {
    qb.addOrderBy(alias, 'ASC');
  }

  return qb;
}

/**
 * افزودن شرط جست‌وجو به کوئری.
 *
 * نکته مهم: شرط‌ها داخل یک گروه (Brackets) و با AND به بقیه کوئری اضافه
 * می‌شوند؛ در غیر این صورت ORها فیلترهای قبلی (موجودی، دسته‌بندی،
 * منتشرشده بودن و ...) را بی‌اثر می‌کنند.
 */
export function applySearch<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  search: unknown,
  fields: string[],
) {
  const term = normalizeSearchTerm(search);

  if (!term || !fields?.length) {
    return qb;
  }

  qb.andWhere(
    new Brackets(searchQb => {
      fields.forEach(field => {
        searchQb.orWhere(
          `${buildNormalizedColumnExpression(field)} LIKE :search`,
          {
            search: `%${term}%`,
          },
        );
      });
    }),
  );

  return qb;
}

/**
 * جست‌وجوی «چندکلمه‌ای»: هر کلمه‌ی عبارت باید در حداقل یکی از ستون‌ها باشد.
 *
 * تفاوتش با `applySearch` این است که ترتیب و پیوستگی کلمات مهم نیست؛
 * «شلوار مردانه» هم «شلوار پارچه‌ای مردانه» را پیدا می‌کند و هم
 * «مردانه - شلوار». همچنین فاصله/نیم‌فاصله بی‌اثر است.
 */
export function applyTokenizedSearch<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  search: unknown,
  fields: string[],
) {
  const term = parseSearchTerm(search);

  if (term.isEmpty || !fields?.length) {
    return qb;
  }

  term.tokens.forEach((token, index) => {
    const param = `searchToken${index}`;

    qb.andWhere(
      new Brackets(tokenQb => {
        fields.forEach(field => {
          tokenQb.orWhere(
            `${buildNormalizedColumnExpression(field)} LIKE :${param}`,
            {
              [param]: `%${token}%`,
            },
          );
        });
      }),
    );
  });

  return qb;
}

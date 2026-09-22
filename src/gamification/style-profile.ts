export type StyleProfileKey = 'A' | 'B' | 'C' | 'D';

export interface StyleProfileContent {
  key: StyleProfileKey;
  slug: string;
  titleEn: string;
  titleFa: string;
  descriptions: string[];
}

export type StyleScores = Record<StyleProfileKey, number>;

export interface StyleProfileAnswer {
  questionNumber: number;
  optionNumber: number;
}

export const STYLE_PROFILES: Record<StyleProfileKey, StyleProfileContent> = {
  A: {
    key: 'A',
    slug: 'classic-gentleman',
    titleEn: 'CLASSIC GENTLEMAN',
    titleFa: 'کلاسیک جنتلمن',
    descriptions: [
      'شما به استایل کلاسیک و همیشه شیک علاقه دارید.',
      'برای شما تناسب، ظرافت و ظاهر رسمی اهمیت زیادی دارد.',
      'انتخاب‌های شما نشان می‌دهد به استایلی اعتماد دارید که هیچ‌وقت از مد نمی‌افتد.',
    ],
  },

  B: {
    key: 'B',
    slug: 'modern-classic',
    titleEn: 'MODERN CLASSIC',
    titleFa: 'مدرن کلاسیک',
    descriptions: [
      'شما ترکیبی از ظرافت کلاسیک و سادگی مدرن را ترجیح می‌دهید.',
      'برای شما لباس باید شیک، دقیق و قابل استفاده در موقعیت‌های مختلف باشد.',
    ],
  },

  C: {
    key: 'C',
    slug: 'smart-casual',
    titleEn: 'SMART CASUAL',
    titleFa: 'اسمارت کژوال',
    descriptions: [
      'شما بین شیک بودن و راحتی تعادل برقرار می‌کنید.',
      'برای شما لباس باید کاربردی، خوش‌پوش و مناسب موقعیت‌های مختلف باشد؛ بدون اینکه بیش از حد رسمی به نظر برسد.',
    ],
  },

  D: {
    key: 'D',
    slug: 'urban-casual',
    titleEn: 'URBAN CASUAL',
    titleFa: 'اربان کژوال',
    descriptions: [
      'شما استایلی راحت، مدرن و شخصی را ترجیح می‌دهید.',
      'برای شما لباس بخشی از شخصیت شماست؛ راحتی مهم است، اما همیشه با چاشنی استایل و تفاوت.',
    ],
  },
};

export const STYLE_PROFILE_KEYS: StyleProfileKey[] = ['A', 'B', 'C', 'D'];

export const STYLE_PROFILE_LIST: StyleProfileContent[] = STYLE_PROFILE_KEYS.map(
  key => STYLE_PROFILES[key],
);

/** گزینه ۱ تا ۴ هر سوال به ترتیب به استایل A تا D نگاشت می‌شود. */
const OPTION_TO_PROFILE: StyleProfileKey[] = ['A', 'B', 'C', 'D'];

/** وزن سوال‌هایی که نگاشت مستقیم دارند. */
const DIRECT_QUESTION_WEIGHTS: Record<number, number> = { 1: 3, 3: 3 };

/** امتیاز هر گزینه از سوال ۴ (نگاشت اختصاصی، مجموع ۲ امتیاز برای هر پاسخ). */
const Q4_SCORING: { profile: StyleProfileKey; points: number }[][] = [
  [{ profile: 'A', points: 2 }],
  [{ profile: 'C', points: 2 }],
  [
    { profile: 'D', points: 1 },
    { profile: 'C', points: 1 },
  ],
  [{ profile: 'D', points: 2 }],
];

const TIE_BREAKER_QUESTIONS = [1, 3, 4];

export function getStyleProfile(
  key: string | null | undefined,
): StyleProfileContent | null {
  if (!key) return null;

  return STYLE_PROFILES[key as StyleProfileKey] ?? null;
}

/**
 * محاسبه امتیاز هر استایل بر اساس پاسخ‌های کاربر
 * (شماره سوال و شماره گزینه — هر دو از ۱ شروع می‌شوند)
 */
export function calculateStyleScores(
  answers: StyleProfileAnswer[] = [],
): StyleScores {
  return calculateScoresFromAnswerMap(toAnswerMap(answers));
}

/**
 * تعیین استایل نهایی کاربر به همراه امتیازها
 */
export function resolveStyleProfile(answers: StyleProfileAnswer[] = []): {
  profile: StyleProfileContent;
  scores: StyleScores;
} {
  const answerMap = toAnswerMap(answers);
  const scores = calculateScoresFromAnswerMap(answerMap);

  return {
    profile: STYLE_PROFILES[pickProfileKey(scores, answerMap)],
    scores,
  };
}

/**
 * فقط کلید استایل نهایی (برای ذخیره در دیتابیس)
 */
export function resolveStyleProfileKey(
  answers: StyleProfileAnswer[] = [],
): StyleProfileKey {
  return resolveStyleProfile(answers).profile.key;
}

function toAnswerMap(answers: StyleProfileAnswer[] = []) {
  return new Map<number, number>(
    (answers ?? []).map(answer => [
      Number(answer.questionNumber),
      Number(answer.optionNumber),
    ]),
  );
}

function toProfileKey(optionNumber?: number): StyleProfileKey | null {
  if (!optionNumber) return null;

  return OPTION_TO_PROFILE[optionNumber - 1] ?? null;
}

function calculateScoresFromAnswerMap(
  answerMap: Map<number, number>,
): StyleScores {
  const scores: StyleScores = { A: 0, B: 0, C: 0, D: 0 };

  Object.entries(DIRECT_QUESTION_WEIGHTS).forEach(
    ([questionNumber, weight]) => {
      const profile = toProfileKey(answerMap.get(Number(questionNumber)));

      if (profile) scores[profile] += weight;
    },
  );

  const q4OptionNumber = answerMap.get(4);
  const q4Scores = q4OptionNumber ? Q4_SCORING[q4OptionNumber - 1] : undefined;

  q4Scores?.forEach(({ profile, points }) => {
    scores[profile] += points;
  });

  return scores;
}

function pickProfileKey(
  scores: StyleScores,
  answerMap: Map<number, number>,
): StyleProfileKey {
  const maxScore = Math.max(...STYLE_PROFILE_KEYS.map(key => scores[key]));

  const winners = STYLE_PROFILE_KEYS.filter(key => scores[key] === maxScore);

  if (winners.length === 1) return winners[0];

  /**
   * تای‌بریکر: اولین سوال (سوال ۱ → ۳ → ۴) که پاسخ آن به یکی از
   * استایل‌های هم‌امتیاز اشاره کند، برنده را مشخص می‌کند.
   */
  for (const questionNumber of TIE_BREAKER_QUESTIONS) {
    const profile = toProfileKey(answerMap.get(questionNumber));

    if (profile && winners.includes(profile)) return profile;
  }

  return winners[0];
}

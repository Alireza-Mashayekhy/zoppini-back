/**
 * کلید عمومی ترب برای اعتبارسنجی توکن درخواست‌ها.
 * الگوریتم: EdDSA (ed25519)
 * منبع: https://panel.torob.com/s/torob_api_token_guide
 */
export const TOROB_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAt6Mu4T0pBORY11W+QeM35UsmLO3vsf+6yKpFDEImFk0=
-----END PUBLIC KEY-----`;

/** هدر JWT ارسالی ترب */
export const TOROB_TOKEN_HEADER = 'x-torob-token';

/**
 * هدر نسخه توکن.
 *
 * نکته: در مستند ترب این هدر دو جا با دو نام متفاوت آمده است
 * (`X-Torob-Token-Version` در راهنمای توکن و `C-Torob-Token-Version` در مستند
 * درگاه)، بنابراین هر دو پذیرفته می‌شوند.
 */
export const TOROB_TOKEN_VERSION_HEADERS = [
  'x-torob-token-version',
  'c-torob-token-version',
] as const;

/** نسخه توکنی که این پیاده‌سازی می‌پذیرد */
export const TOROB_SUPPORTED_TOKEN_VERSION = '1';

/**
 * تلورانس زمانی (ثانیه) برای جلوگیری از رد شدن درخواست‌ها به خاطر اختلاف ساعت سرور.
 * مستند ترب روی درست بودن ساعت سرور تأکید دارد، پس این مقدار عمداً کوچک نگه داشته شده.
 */
export const TOROB_CLOCK_SKEW_SECONDS = 30;

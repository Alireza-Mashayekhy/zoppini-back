# درگاه پرداخت تارا (IPG)

پیاده‌سازی بر پایهٔ «مستند سرویس‌های خرید اینترنتی تارا (بر پایه وب)».

Base URL: `https://pay.tara360.ir/pay` — هدر احراز هویت: `Authorization: bearer {accessToken}`

## متغیرهای محیطی

| متغیر                          | اجباری | توضیح                                                                                       |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------- |
| `TARA_API_URL`                 | بله    | آدرس پایهٔ API تارا                                                                         |
| `TARA_USERNAME`                | بله    | نام کاربری پذیرنده (برای لاگین **و** برای فیلد `username` فرم هدایت به `ipgPurchase`)       |
| `TARA_PASSWORD`                | بله    | رمز عبور پذیرنده                                                                            |
| `APP_URL`                      | بله\*  | آدرس عمومی بک‌اند؛ اگر `TARA_PAYMENT_CALLBACK_URL` ست نباشد، آدرس بازگشت از آن ساخته می‌شود |
| `TARA_PAYMENT_CALLBACK_URL`    | خیر    | آدرس بازگشت (callback) — پیش‌فرض: `{APP_URL}/api/payment/callback/tara`                     |
| `TARA_SERVICE_ID`              | خیر    | شمارهٔ سرویس (`serviceId` از نوع long در مدل `ServiceAmount`) — پیش‌فرض: `1`                |
| `TARA_MERCHANDISE_GROUP`       | خیر    | کد گروه کالایی آیتم‌های فاکتور (`group`)                                                    |
| `TARA_MERCHANDISE_GROUP_TITLE` | خیر    | عنوان گروه کالایی (`groupTitle`)                                                            |

\* اگر هر دو `TARA_PAYMENT_CALLBACK_URL` و `APP_URL` خالی باشند، `callBackUrl` خالی ارسال
می‌شود و تارا خطای `92 = فرمت آدرس برگشتی صحیح نمیباشد` برمی‌گرداند؛ به همین دلیل در این
حالت درخواست پرداخت با خطای روشن متوقف می‌شود.

## جریان اجرا

1. **احراز هویت** — `POST /api/v2/authenticate` با `{username, password}`.
   پاسخ شامل `accessToken`, `result`, `description`, `doTime`, `expireTime` است.
   توکن در حافظه کش می‌شود و یک دقیقه پیش از انقضا تازه می‌شود.
   اگر `result` غیر صفر باشد (مثلاً `2 = نام کاربری یا رمز عبور نامعتبر است`) خطا ثبت می‌شود.
2. **دریافت توکن** — `POST /api/getToken` با `ip` واقعی کاربر،
   `serviceAmountList`, `taraInvoiceItemList`, `callBackUrl`, `amount` (string),
   `mobile`, `orderId`, `vat`.
   `unit` آیتم‌ها روی `5 = عدد` تنظیم شده است.
3. **هدایت کاربر** — فرم HTML با `Content-Type: form-data` به `POST /api/ipgPurchase`
   با دو فیلد `username` و `token`.
   endpoint پرداخت (`POST /api/payment/start`) مقدارهای `{refId, payUrl, username}` را
   برمی‌گرداند تا فرانت فرم را بسازد.
4. **بازگشت از درگاه** — `ALL /api/payment/callback/tara` (هم GET و هم POST) با
   `result`, `desc`, `token`, `channelRefNumber`, `additionalData`, `orderId`.
   اگر `result !== 0` باشد، طبق مستند **نباید** `purchaseVerify` صدا زده شود
   (مبلغ حداکثر تا ۳۰ دقیقه خودکار برگشت می‌خورد) و تراکنش ناموفق ثبت می‌شود.
5. **تأیید خرید** — `POST /api/purchaseVerify` با `{ip, token}`.
   مبلغ بازگشتی (`amount`) با مبلغ ثبت‌شدهٔ تراکنش مقایسه می‌شود و در صورت مغایرت،
   سفارش تأیید نمی‌گردد. `rrn` (string) در ستون `saleReferenceId` ذخیره می‌شود.
6. **استعلام** — اگر از `purchaseVerify` پاسخی نگیریم، `POST /api/purchaseInquiry`
   صدا زده می‌شود و در صورت موفق بودن نتیجه، پرداخت نهایی می‌شود؛ وگرنه تراکنش
   `PENDING` می‌ماند.

کدهای خطا در `src/payment/utils/tara.constants.ts` (تابع `describeTaraResult`) نگاشت شده‌اند
تا در لاگ‌ها پیام فارسیِ خودِ مستند دیده شود.

## موارد باقی‌مانده (نیازمند اطلاعات پذیرنده)

- **نگاشت گروه‌های کالایی**: بخش ۲-۱ مستند، دریافت `/api/clubGroups` و نگاشت
  دسته‌بندی محصولات به گروه‌های تارا را «ضروری» دانسته است. تا زمان تأمین جدول نگاشت،
  `group` و `groupTitle` از env خوانده می‌شوند.
- **`serviceId` واقعی** که تارا به پذیرنده می‌دهد (خطاهای `9` و `91`).
- **برگشت وجه (refund)**: سرویس‌های `/api/v1/user/login/refund` و
  `/api/v1/user/purchase/limited/refund/{referenceNumber}` (کامل و جزئی) هنوز پیاده نشده‌اند.
- **هزینهٔ ارسال و تخفیف**: جمع `taraInvoiceItemList` باید با `amount` یکی باشد
  (خطای `11 = مبالغ یکسان نیست`). اگر سفارش هزینهٔ ارسال یا تخفیف دارد، باید به‌صورت
  آیتم در فاکتور لحاظ شود؛ فعلاً در صورت مغایرت، هشدار در لاگ ثبت می‌شود.

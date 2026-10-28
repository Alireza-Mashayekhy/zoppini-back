import { Body, Controller, Post, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { SendOtpDto } from 'src/auth/dto/send-otp.dto';
import request from 'supertest';

import { setupBodyParsers } from './body-parser.config';

/**
 * رگرسیون باگ واقعی: `POST /api/auth/send-otp` با شماره‌ی درست ۱۱ رقمی خطای
 * «phone must be longer than or equal to 11 characters» + «should not be empty»
 * می‌داد. هر سه پیام با هم فقط وقتی رخ می‌دهد که `phone` در بدنه‌ی پارس‌شده
 * وجود نداشته باشد — یعنی بدنه به‌دلیل Content-Type (مثلاً text/plain پس از
 * پراکسی یا فرم‌های urlencoded) پارس نشده بود، نه اینکه طول شماره غلط باشد.
 */
@Controller('auth')
class AuthStubController {
  @Post('send-otp')
  sendOtp(@Body() dto: SendOtpDto) {
    return { phone: dto.phone };
  }
}

describe('setupBodyParsers', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthStubController],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api');
    setupBodyParsers(app);
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const path = '/api/auth/send-otp';

  it('بدنه‌ی JSON استاندارد را می‌پذیرد', async () => {
    await request(app.getHttpServer())
      .post(path)
      .send({ phone: '09918690340' })
      .expect(201)
      .expect({ phone: '09918690340' });
  });

  it('بدنه‌ای که با Content-Type: text/plain ارسال شده را هم پارس می‌کند', async () => {
    await request(app.getHttpServer())
      .post(path)
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ phone: '09918690340' }))
      .expect(201)
      .expect({ phone: '09918690340' });
  });

  it('بدنه‌ی form-urlencoded (فرم‌های HTML/Postman) را پارس می‌کند', async () => {
    await request(app.getHttpServer())
      .post(path)
      .type('form')
      .send({ phone: '09918690340' })
      .expect(201)
      .expect({ phone: '09918690340' });
  });

  it('بدنه‌ی خالی را با پیام فارسی و قابل‌فهم رد می‌کند (نه سه خطای هم‌زمان طول)', async () => {
    const response = await request(app.getHttpServer())
      .post(path)
      .set('Content-Type', 'application/json')
      .send({})
      .expect(400);

    expect(response.body.message).toContain('شماره موبایل الزامی است');
    expect(JSON.stringify(response.body)).not.toMatch(
      /must be (longer|shorter)/,
    );
  });
});

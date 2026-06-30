// seed.ts
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';

import { seedLocations } from './src/common/seeds/seed-locations';
import { City } from './src/locations/entities/city.entity';
import { Province } from './src/locations/entities/province.entity';

dotenv.config();

const dataSource = new DataSource({
  type: 'mysql',
  host: process.env.DATABASE_HOST,
  port: parseInt(process.env.DATABASE_PORT || '3306', 10),
  username: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  entities: [Province, City], // فقط این دو کلاس
  synchronize: false,
  logging: true,
});

async function run() {
  let isConnected = false;
  try {
    await dataSource.initialize();
    isConnected = true;
    console.log('✅ اتصال به دیتابیس برقرار شد.');
    await seedLocations(dataSource);
    console.log('🎉 عملیات سید با موفقیت انجام شد.');
  } catch (error) {
    console.error('❌ خطا در اجرای سید:', error);
  } finally {
    if (isConnected) {
      await dataSource.destroy();
    }
  }
}

run().catch(err => console.log(err));

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Category } from 'src/categories/entities/category.entity';
import { FilesModule } from 'src/files/files.module';
import { Product } from 'src/products/entities/product.entity';

import { ProductGuidesAdminController } from './admin.product-guides.controller';
import { CareGuide, CareInstruction } from './entities/care-guide.entity';
import {
  CategoryGuideSetting,
  ProductGuideOverride,
  ProductGuideSetting,
} from './entities/guide-assignment.entity';
import {
  MeasurementGuide,
  MeasurementImage,
} from './entities/measurement-guide.entity';
import {
  SizeTable,
  SizeTableCell,
  SizeTableColumn,
  SizeTableRow,
} from './entities/size-table.entity';
import { ProductGuidesController } from './product-guides.controller';
import { ProductGuidesService } from './product-guides.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SizeTable,
      SizeTableColumn,
      SizeTableRow,
      SizeTableCell,
      CareGuide,
      CareInstruction,
      MeasurementGuide,
      MeasurementImage,
      CategoryGuideSetting,
      ProductGuideSetting,
      ProductGuideOverride,
      Product,
      Category,
    ]),
    FilesModule,
  ],
  controllers: [ProductGuidesController, ProductGuidesAdminController],
  providers: [ProductGuidesService],
  exports: [ProductGuidesService],
})
export class ProductGuidesModule {}

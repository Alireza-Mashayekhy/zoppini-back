import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('guide_size_tables')
export class SizeTable {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 150 })
  name: string;

  /** واحد اندازه‌گیری — مثل «سانتیمتر» */
  @Column({ length: 30, default: 'سانتیمتر' })
  unit: string;

  /** توضیحات جدول (اختیاری) */
  @Column({ type: 'text', nullable: true })
  notes: string | null;

  /** بایگانی به‌جای حذف کامل */
  @Index()
  @Column({ default: false })
  isArchived: boolean;

  @OneToMany(() => SizeTableColumn, column => column.sizeTable, {
    cascade: true,
  })
  columns: SizeTableColumn[];

  @OneToMany(() => SizeTableRow, row => row.sizeTable, { cascade: true })
  rows: SizeTableRow[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** ستون جدول سایزبندی — مثل S ، M ، L ، XL یا ۴۶ ، ۴۸ ، ۵۰ */
@Entity('guide_size_table_columns')
export class SizeTableColumn {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => SizeTable, sizeTable => sizeTable.columns, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'size_table_id' })
  sizeTable: SizeTable;

  @Index()
  @Column({ name: 'size_table_id' })
  sizeTableId: number;

  @Column({ length: 50 })
  label: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  order: number;
}

/** ردیف جدول سایزبندی — مثل «عرض سینه»، «قد آستین»، «قد لباس» */
@Entity('guide_size_table_rows')
export class SizeTableRow {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => SizeTable, sizeTable => sizeTable.rows, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'size_table_id' })
  sizeTable: SizeTable;

  @Index()
  @Column({ name: 'size_table_id' })
  sizeTableId: number;

  @Column({ length: 150 })
  label: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  order: number;

  @OneToMany(() => SizeTableCell, cell => cell.row, { cascade: true })
  cells: SizeTableCell[];
}

@Entity('guide_size_table_cells')
@Unique(['rowId', 'columnId'])
export class SizeTableCell {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => SizeTableRow, row => row.cells, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'row_id' })
  row: SizeTableRow;

  @Index()
  @Column({ name: 'row_id' })
  rowId: number;

  @ManyToOne(() => SizeTableColumn, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'column_id' })
  column: SizeTableColumn;

  @Index()
  @Column({ name: 'column_id' })
  columnId: number;

  /** مقدار اندازه — به صورت متن ذخیره می‌شود تا اعشار و ارقام فارسی هم ممکن باشد */
  @Column({ type: 'varchar', length: 30, nullable: true })
  value: string | null;
}

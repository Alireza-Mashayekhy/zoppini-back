import { Role } from 'src/common/enum/role.enum';
import { Comment } from 'src/products/entities/comment.entity';
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  fullName: string;

  @Column({ unique: true })
  phone: string;

  @Column({
    type: 'varchar',
    length: 255,
    unique: true,
    nullable: true,
  })
  email: string | null;

  @Column()
  password: string;

  @Column({ type: 'datetime', nullable: true })
  birthDate: Date | null;

  @Column({
    type: 'simple-array',
  })
  roles: Role[] = [Role.User];

  @Column({ default: true })
  isActive: boolean;

  @Column({ nullable: true })
  nationalCode: string;

  /**
   * شناسهٔ مشتری در راهکاران (`CustomerService`).
   * بعد از اولین ثبت/یافتن مشتری پر می‌شود تا ثبت دوباره انجام نشود.
   */
  @Column({ nullable: true })
  rahkaranId: number;

  /**
   * زمان موفقیت ثبت این کاربر در «مشتریان وفادار» راهکاران.
   *
   * ثبت مشتری و ثبت عضویت وفاداری دو عملیات جدا هستند؛ این ستون فقط بعد
   * از موفقیت عضویت پر می‌شود تا فراخوانی‌های بعدی (ثبت‌نام دوباره،
   * نظرسنجی، retry دستی) عضویت تکراری نسازند و عملیات نیمه‌تمام قابل
   * تکمیل باشد.
   */
  @Column({
    name: 'loyalty_member_synced_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  loyaltyMemberSyncedAt: Date | null;

  @Column({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;

  @Column({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
    onUpdate: 'CURRENT_TIMESTAMP',
  })
  updatedAt: Date;

  @OneToMany(() => Comment, comment => comment.user)
  comments: Comment[];
}

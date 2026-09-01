import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('reseller_users')
export class ResellerUser {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'varchar', length: 255 })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 20, default: 'demo' })
  role!: string; // demo | admin | operator | viewer

  @Column({ type: 'varchar', nullable: true })
  apiKeyId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  apiKeyRaw!: string | null; // stored raw key for demo login to return

  @Column({ type: 'int', nullable: true })
  credits!: number | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

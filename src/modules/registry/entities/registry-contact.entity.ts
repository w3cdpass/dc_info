import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, UpdateDateColumn } from 'typeorm';

/**
 * A locally-persisted lead/contact registry for the cold-outreach workflow. This is the app's OWN
 * address book (survives restarts, is independent of WhatsApp's per-account addressbook) and is the
 * dedupe source for bulk import: a phone already present here is never double-saved. `phone` is the
 * normalized MSISDN digits so dedupe is stable across `@c.us`/`@s.whatsapp.net` variants and bare
 * numbers.
 */
@Entity('registry_contacts')
@Index('UQ_registry_contacts_phone', ['phone'], { unique: true })
export class RegistryContact {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  phone!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name?: string | null;

  /** The outreach campaign that imported this lead, when known. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  campaignId?: string | null;

  /** The session (number) this lead is earmarked for, when known. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  sessionName?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}

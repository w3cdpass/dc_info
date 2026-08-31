import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum BlockKind {
  BLOCKED = 'blocked',
  REPORTED = 'reported',
}

/**
 * A locally-persisted registry of numbers that blocked us or reported us (us = this app's numbers).
 * Persists the "who did I lose" picture across restarts so the dashboard can show warm-up/rest
 * health and auto-stop signals without re-querying every WhatsApp engine. Rows come from two
 * sources: `manual` (operator-recorded) and `engine` (a detected block/report).
 */
@Entity('registry_blocked')
@Index('UQ_registry_blocked_phone_kind', ['phone', 'kind'], { unique: true })
export class RegistryBlocked {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 32 })
  phone!: string;

  @Column({ type: 'varchar', length: 16, default: BlockKind.BLOCKED })
  kind!: BlockKind;

  /** Which of our sessions (numbers) lost this contact, when known. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  sessionName?: string | null;

  /** `manual` (operator-recorded) or `engine` (detected by this app). */
  @Column({ type: 'varchar', length: 16, default: 'manual' })
  source!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

export enum OutreachStatus {
  SCHEDULED = 'scheduled',
  RUNNING = 'running',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
}

/**
 * A single logical cold-outreach wave fanned out across MULTIPLE WhatsApp sessions (numbers) using
 * round-robin burst allocation. Each session receives a balanced share of the contact list, split
 * into bursts separated by cool-downs, and the bursts are staggered across numbers so that while one
 * number is cooling down another is sending — spreading one contact wave across many companion
 * devices over time instead of hammering a single number with the whole list.
 */
@Entity('outreach_campaigns')
export class OutreachCampaign {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 20, default: OutreachStatus.SCHEDULED })
  status!: OutreachStatus;

  /**
   * The template text sent to each contact. Placeholders are substituted from `variableMap`
   * (e.g. `{{name}}`). Every recipient of a given campaign receives this same copy here; a
   * per-number copy rotation is handled at outreach time from a provided variants list.
   */
  @Column({ type: 'text' })
  messageText!: string;

  /** Static variable substitution for the template, e.g. sender's own name / brand. */
  @Column({ type: jsonColumnType(), nullable: true })
  variableMap!: Record<string, string> | null;

  /**
   * Contact list for this wave. Round-robin balanced across the session pool, then split into
   * bursts. `phone` is the raw phone; `name` optional display name for saveContactFirst.
   */
  @Column({ type: jsonColumnType() })
  contacts!: Array<{ phone: string; name?: string }>;

  /** The session pool (session names) this wave is fanned out across. */
  @Column({ type: jsonColumnType() })
  sessions!: Array<{ sessionName: string; sessionId: string }>;

  /**
   * Strategy knobs:
   *  - burstSize: max recipients sent by one session per burst before its cool-down (`0` = no cap).
   *  - cooldownMinMs/cooldownMaxMs: session pause after each burst; a RANDOM value in the range
   *    (e.g. 4–8 min) is drawn per burst so the rhythm looks human instead of metronomic.
   *  - pacing: `{ minDelayMs, maxDelayMs }` humanized delay between individual sends inside a burst.
   *  - warmupSchedule: per-account-age max sends/day (days since session createdAt). Session's
   *    remaining daily capacity is min(its warmup allowance, its share of this wave).
   */
  @Column({ type: jsonColumnType() })
  strategy!: {
    burstSize: number;
    cooldownMinMs: number;
    cooldownMaxMs: number;
    warmupSchedule: number[];
    pacing: { minDelayMs: number; maxDelayMs: number };
    preCheckNumbers: boolean;
    saveContactFirst: boolean;
    contactName?: string;
    maxPerSessionPerDay?: number;
  };

  /**
   * The exact per-session assignment produced by the allocation engine at create time (ordered
   * contact lists + burst indices). Persisted so the runtime and a resumed campaign use the same
   * plan and never re-derive it from scratch.
   */
  @Column({ type: jsonColumnType(), nullable: true })
  distribution!: Array<{
    sessionId: string;
    sessionName: string;
    assigned: number;
    contacts: Array<{ phone: string; name?: string }>;
    bursts: Array<{ burstIndex: number; contacts: Array<{ phone: string; name?: string }> }>;
  }> | null;

  /** Per-session running tally of recipients attempted, sent, and failed on this wave. */
  @Column({ type: jsonColumnType(), nullable: true })
  sessionProgress!: Array<{
    sessionName: string;
    sessionId: string;
    total: number;
    sent: number;
    failed: number;
    blocked: number;
    pending: number;
  }> | null;

  /**
   * Per-burst delivery tracking: for every burst inside every session, store
   * sent/failed/blocked/pending, timing (actual + estimated) and per-recipient
   * results. Updated in real-time as batches complete.
   */
  @Column({ type: jsonColumnType(), nullable: true })
  burstProgress!: Array<{
    sessionId: string;
    sessionName: string;
    burstIndex: number;
    burstSize: number;
    batchId: string | null;
    status: 'pending' | 'running' | 'cooldown' | 'completed' | 'failed';
    sent: number;
    failed: number;
    blocked: number;
    pending: number;
    contacts: Array<{ phone: string; name?: string }>;
    results: Array<{ phone: string; name?: string; chatId: string; status: string; errorCode?: string; errorMessage?: string; sentAt?: string }>;
    startTime: string | null;
    endTime: string | null;
    estimatedStart: string | null;
    estimatedEnd: string | null;
    cooldownMs: number | null;
    warmupMs: number | null;
  }> | null;

  /** All batch IDs created during this campaign (for querying per-recipient execution results). */
  @Column({ type: jsonColumnType(), nullable: true })
  batchIds!: string[] | null;

  @Column({ type: jsonColumnType(), nullable: true })
  error!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ name: 'started_at', type: dateColumnType(), nullable: true, transformer: DateTransformer })
  startedAt!: Date | null;

  @Column({ name: 'completed_at', type: dateColumnType(), nullable: true, transformer: DateTransformer })
  completedAt!: Date | null;
}

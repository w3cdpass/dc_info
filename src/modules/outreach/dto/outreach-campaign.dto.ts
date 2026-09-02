import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';
import { OutreachStatus } from '../entities/outreach-campaign.entity';

class OutreachContactDto {
  @ApiProperty({ description: 'Recipient phone number (international, digits only preferred).' })
  @IsString()
  @MinLength(5)
  phone!: string;

  @ApiPropertyOptional({ description: 'Optional display name (used for saveContactFirst).' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;
}

class OutreachSessionRefDto {
  @ApiProperty({ description: 'Session name (e.g. line-1). Must map to a registered session.' })
  @IsString()
  @MinLength(1)
  sessionName!: string;
}

class OutreachPacingDto {
  @ApiPropertyOptional({ description: 'Humanized delay lower bound (ms) between sends. Default 30000.' })
  @IsOptional()
  @IsNumber()
  @Min(3000)
  minDelayMs?: number;

  @ApiPropertyOptional({ description: 'Humanized delay upper bound (ms) between sends. Default 120000.' })
  @IsOptional()
  @IsNumber()
  @Min(3000)
  maxDelayMs?: number;
}

class OutreachStrategyDto {
  @ApiPropertyOptional({
    description: 'Recipients one session sends before cooling down. 0 = single burst for the whole share. Default 10.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  burstSize?: number;

  @ApiPropertyOptional({
    description:
      'Cooldown lower bound (ms) a session pauses between bursts. A random value in ' +
      '[cooldownMinMs, cooldownMaxMs] is drawn per burst so the rhythm looks human. Default 240000 (4 min).',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  cooldownMinMs?: number;

  @ApiPropertyOptional({
    description:
      'Cooldown upper bound (ms) a session pauses between bursts. Must be >= cooldownMinMs. ' +
      'Default 480000 (8 min).',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  cooldownMaxMs?: number;

  @ApiPropertyOptional({
    description:
      'Hard ceiling: max messages any single session may send this wave (enforced in allocation). ' +
      'Use to prevent the allocator from assigning more than a number can safely send in the window. ' +
      'Default: no extra cap (only warm-up schedule applies).',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxPerSessionPerDay?: number;

  @ApiPropertyOptional({
    description:
      'Warm-up ramp: max sends/day by account age in days. Newest day first. ' +
      'Default [20, 40, 80, 160, 320, 640, 1000].',
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  warmupSchedule?: number[];

  @ApiPropertyOptional({ type: OutreachPacingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OutreachPacingDto)
  pacing?: OutreachPacingDto;

  @ApiPropertyOptional({
    description: 'Anti-ban: drop recipients not registered on WhatsApp before sending. Default true.',
  })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  preCheckNumbers?: boolean;

  @ApiPropertyOptional({
    description: 'Anti-ban: save each recipient into the account addressbook before sending. Default true.',
  })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  saveContactFirst?: boolean;

  @ApiPropertyOptional({
    description: 'Contact first name used for saveContactFirst when a contact has no name. Default phone.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  contactName?: string;
}

export class CreateOutreachCampaignDto {
  @ApiProperty({ description: 'Campaign name.', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ description: 'Message template sent to each contact.' })
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  messageText!: string;

  @ApiPropertyOptional({ description: 'Static variable map for template substitution.' })
  @IsOptional()
  @IsObject()
  variableMap?: Record<string, string>;

  @ApiProperty({ type: [OutreachContactDto], description: 'Recipients for this wave (max 2000).' })
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => OutreachContactDto)
  contacts!: OutreachContactDto[];

  @ApiProperty({
    type: [OutreachSessionRefDto],
    description: 'Session pool this wave is fanned out across (names).',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OutreachSessionRefDto)
  sessions!: OutreachSessionRefDto[];

  @ApiPropertyOptional({ type: OutreachStrategyDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OutreachStrategyDto)
  strategy?: OutreachStrategyDto;
}

export class OutreachSessionProgressDto {
  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  sessionName!: string;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  sent!: number;

  @ApiProperty()
  failed!: number;

  @ApiPropertyOptional()
  blocked?: number;

  @ApiProperty()
  pending!: number;
}

export class OutreachBurstProgressDto {
  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  sessionName!: string;

  @ApiProperty()
  burstIndex!: number;

  @ApiProperty()
  burstSize!: number;

  @ApiPropertyOptional({ nullable: true })
  batchId!: string | null;

  @ApiProperty({ enum: ['pending', 'running', 'cooldown', 'completed', 'failed'] })
  status!: string;

  @ApiProperty()
  sent!: number;

  @ApiProperty()
  failed!: number;

  @ApiProperty()
  blocked!: number;

  @ApiProperty()
  pending!: number;

  @ApiPropertyOptional({ type: [Object] })
  contacts?: Array<{ phone: string; name?: string }>;

  @ApiPropertyOptional({ type: [Object] })
  results?: Array<{
    phone: string;
    name?: string;
    chatId: string;
    status: string;
    errorCode?: string;
    errorMessage?: string;
    sentAt?: string;
  }>;

  @ApiPropertyOptional({ nullable: true })
  startTime!: string | null;

  @ApiPropertyOptional({ nullable: true })
  endTime!: string | null;

  @ApiPropertyOptional({ nullable: true })
  estimatedStart!: string | null;

  @ApiPropertyOptional({ nullable: true })
  estimatedEnd!: string | null;

  @ApiPropertyOptional({ nullable: true })
  cooldownMs!: number | null;

  @ApiPropertyOptional({ nullable: true })
  warmupMs!: number | null;
}

export class OutreachGlobalTimingDto {
  @ApiPropertyOptional({ nullable: true })
  startedAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  estimatedFinish!: string | null;

  @ApiProperty()
  remainingBursts!: number;

  @ApiProperty()
  totalBursts!: number;

  @ApiProperty()
  completedBursts!: number;
}

export class OutreachCampaignResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: OutreachStatus })
  status!: OutreachStatus;

  @ApiProperty()
  messageText!: string;

  @ApiProperty()
  contactCount!: number;

  @ApiProperty()
  sessionCount!: number;

  @ApiPropertyOptional({ type: [OutreachSessionProgressDto] })
  sessionProgress?: OutreachSessionProgressDto[] | null;

  @ApiPropertyOptional({ type: [OutreachBurstProgressDto] })
  burstProgress?: OutreachBurstProgressDto[] | null;

  @ApiPropertyOptional({ type: OutreachGlobalTimingDto })
  globalTiming?: OutreachGlobalTimingDto | null;

  @ApiPropertyOptional({ type: [String], description: 'All batch IDs created during this campaign.' })
  batchIds?: string[] | null;

  /**
   * The per-session burst plan produced at allocation time. Each entry carries the ordered contact
   * list assigned to that session AND the burst boundaries (burstIndex + the contacts in that
   * burst) so the dashboard can render "session A: messages 1..30, cooldown, 31..60..." queues.
   */
  @ApiPropertyOptional({
    description: 'Per-session burst allocation plan (ordered contacts + burst boundaries).',
  })
  distribution?: Array<{
    sessionId: string;
    sessionName: string;
    assigned: number;
    contacts: Array<{ phone: string; name?: string }>;
    bursts: Array<{ burstIndex: number; contacts: Array<{ phone: string; name?: string }> }>;
  }> | null;

  /** The effective strategy knobs for this wave (drives the burst UI). */
  @ApiPropertyOptional({ description: 'Effective strategy knobs.' })
  strategy?: {
    burstSize: number;
    cooldownMinMs: number;
    cooldownMaxMs: number;
    warmupSchedule: number[];
    pacing: { minDelayMs: number; maxDelayMs: number };
    preCheckNumbers: boolean;
    saveContactFirst: boolean;
    contactName?: string;
    maxPerSessionPerDay?: number;
  } | null;

  /** The session pool (names + ids) this wave is fanned out across. */
  @ApiPropertyOptional({ description: 'Session pool.' })
  sessions?: Array<{ sessionName: string; sessionId: string }> | null;

  @ApiPropertyOptional()
  error?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  startedAt?: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  completedAt?: Date | null;
}

export class OutreachCampaignActionDto {
  @ApiProperty({ description: 'Campaign id.' })
  @IsString()
  @MinLength(1)
  id!: string;
}

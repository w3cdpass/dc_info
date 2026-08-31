import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsArray,
  IsOptional,
  IsIn,
  MaxLength,
  IsBoolean,
  ArrayMaxSize,
  Min,
  IsInt,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';

export class ImportContactItemDto {
  @ApiProperty({ description: 'Phone number (digits only, e.g. 628123456789)', example: '628123456789' })
  @IsString()
  @MaxLength(32)
  phone!: string;

  @ApiPropertyOptional({ description: 'Optional display name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;
}

export class ImportContactsDto {
  @ApiProperty({ type: [ImportContactItemDto], description: 'Numbers to import (max 5000 per call)' })
  @IsArray()
  @ArrayMaxSize(5000)
  @Type(() => ImportContactItemDto)
  items!: ImportContactItemDto[];

  @ApiPropertyOptional({
    description:
      'When true, also skip numbers already present in the session(s) WhatsApp addressbook (engine truth). ' +
      'Default false — the local registry is the dedupe source.',
    default: false,
  })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  checkWhatsAppAddressbook?: boolean;

  @ApiPropertyOptional({
    description: 'When true, save each new number into the WhatsApp addressbook of `sessionName` (mirror write).',
    default: false,
  })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  saveToWhatsApp?: boolean;

  @ApiPropertyOptional({
    description: 'The session (number) to mirror-save the imported contacts into, when `saveToWhatsApp` is on. Defaults to the first ready session.',
    example: 'iuytre-kjuhgf',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sessionName?: string;

  @ApiPropertyOptional({ description: 'Campaign id this import belongs to (for tracing).' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  campaignId?: string;

  @ApiPropertyOptional({
    description:
      'When true, run a live engine number-check on each candidate number (via the first ready session) ' +
      'and DROP numbers that are not registered on WhatsApp. Slower — one engine RPC per number. ' +
      'Default false.',
    default: false,
  })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  verifyOnWhatsApp?: boolean;
}

export class ImportContactsResultDto {
  @ApiProperty({ description: 'Total distinct valid numbers submitted.' })
  total!: number;

  @ApiProperty({ description: 'Numbers newly added to the local registry.' })
  added!: number;

  @ApiProperty({ description: 'Numbers skipped because they were already in the local registry.' })
  duplicatesLocal!: number;

  @ApiProperty({ description: 'Numbers skipped because they were already in the WhatsApp addressbook (when the option was on).' })
  duplicatesWhatsApp!: number;

  @ApiProperty({ description: 'Numbers rejected because they are not valid phone numbers.' })
  invalid!: number;

  @ApiProperty({ description: 'Numbers dropped because they are not registered on WhatsApp (when the option was on).' })
  notOnWhatsApp!: number;

  @ApiProperty({ type: [String], description: 'Normalized phone digits that were newly added.' })
  addedPhones!: string[];
}

export class RegistryContactDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Normalized phone (digits).' })
  phone!: string;

  @ApiPropertyOptional()
  name?: string | null;

  @ApiPropertyOptional()
  campaignId?: string | null;

  @ApiPropertyOptional()
  sessionName?: string | null;

  @ApiProperty({ description: 'Whether any session received a reply from this number.' })
  replied!: boolean;

  @ApiPropertyOptional({ description: 'ISO timestamp of the latest incoming message from this number.' })
  lastIncomingAt?: string | null;

  @ApiProperty({ description: 'Incoming message count across all sessions.' })
  incomingCount!: number;

  @ApiProperty({ format: 'date-time', description: 'When this lead was imported into the registry.' })
  createdAt!: Date;
}

export class RecordBlockedDto {
  @ApiProperty({ description: 'The number that blocked us (digits).' })
  @IsString()
  @MaxLength(32)
  phone!: string;

  @ApiPropertyOptional({ enum: ['blocked', 'reported'], default: 'blocked' })
  @IsOptional()
  @IsIn(['blocked', 'reported'])
  kind?: 'blocked' | 'reported';

  @ApiPropertyOptional({ description: 'Which of our sessions (numbers) lost this contact.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sessionName?: string;

  @ApiPropertyOptional({ enum: ['manual', 'engine'], default: 'manual' })
  @IsOptional()
  @IsIn(['manual', 'engine'])
  source?: 'manual' | 'engine';
}

export class RegistryBlockedDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  phone!: string;

  @ApiProperty({ enum: ['blocked', 'reported'] })
  kind!: 'blocked' | 'reported';

  @ApiPropertyOptional()
  sessionName?: string | null;

  @ApiProperty()
  source!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class ReplyTrackingQueryDto {
  @ApiPropertyOptional({ description: 'Limit, default 200.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class SessionReplyStatsDto {
  @ApiProperty({ description: 'Session name.' })
  sessionName!: string;

  @ApiProperty({ description: 'Session id.' })
  sessionId!: string;

  @ApiProperty({ description: 'Total recipients sent to (across registry + campaigns).' })
  sent!: number;

  @ApiProperty({ description: 'Distinct numbers that replied incoming.' })
  replied!: number;

  @ApiProperty({ description: 'Reply rate as a fraction 0..1.' })
  replyRate!: number;

  @ApiProperty({ description: 'Distinct numbers that blocked us (registry).' })
  blocked!: number;

  @ApiProperty({ description: 'Distinct numbers that reported us (registry).' })
  reported!: number;
}

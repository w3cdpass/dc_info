import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength, Matches } from 'class-validator';

/**
 * A snapshot label and the target session name share OpenWA's conservative session-name charset:
 * both become directory keys under the snapshot/credential roots, so a '.', '/' or '\\' could
 * traverse outside them (arbitrary write / `rm -rf` on remove). Enforce that at the boundary.
 */
export class CreateSessionSnapshotDto {
  @ApiProperty({
    description: 'Label for the credential snapshot (alphanumeric and hyphens only)',
    example: 'line-1-2026-08',
    minLength: 1,
    maxLength: 100,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9-]+$/, {
    message: 'Snapshot name can only contain letters, numbers, and hyphens',
  })
  name!: string;
}

export class RestoreSessionSnapshotDto {
  @ApiProperty({
    description: 'Label of the saved snapshot to restore',
    example: 'line-1-2026-08',
    minLength: 1,
    maxLength: 100,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9-]+$/, {
    message: 'Snapshot name can only contain letters, numbers, and hyphens',
  })
  name!: string;

  @ApiProperty({
    description:
      'Name for the brand-new isolated session that will inherit the snapshot credentials. ' +
      'It must not already exist. After restore, POST /sessions/{id}/start reconnects this session ' +
      'to WhatsApp WITHOUT a fresh QR scan.',
    example: 'line-1-copy',
    minLength: 3,
    maxLength: 50,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9-]+$/, {
    message: 'Session name can only contain letters, numbers, and hyphens',
  })
  newSessionName!: string;
}

export class SessionSnapshotResponseDto {
  @ApiProperty({ example: 'line-1-2026-08' })
  name!: string;

  @ApiProperty({ example: 'line-1', description: 'Session the snapshot was taken from' })
  sourceSessionName!: string;

  @ApiProperty({
    example: ['whatsapp-web.js'],
    description: 'Engine credential sets captured in the snapshot',
    type: [String],
  })
  engines!: string[];

  @ApiProperty({ example: '917717574707', nullable: true, description: 'Linked WhatsApp number, if known' })
  phone!: string | null;

  @ApiProperty({ example: '2026-08-29T06:24:44.807Z', description: 'When the snapshot was written' })
  createdAt!: Date;

  @ApiProperty({ description: 'Total on-disk size of the snapshot in bytes' })
  sizeBytes!: number;

  @ApiProperty({ description: 'Number of files captured in the snapshot' })
  fileCount!: number;

  @ApiPropertyOptional({
    example: 'line-2',
    description: 'Whether this snapshot was restored and, if so, the session names it has been cloned into.',
  })
  restoredInto?: string[];
}

export class DeleteSessionSnapshotResponseDto {
  @ApiProperty({ example: 'line-1-2026-08' })
  name!: string;

  @ApiProperty({ example: true })
  deleted!: boolean;
}

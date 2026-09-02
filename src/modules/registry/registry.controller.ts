import { Controller, Get, Post, Delete, Body, Query, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { RegistryService } from './registry.service';
import {
  ImportContactsDto,
  ImportContactsResultDto,
  RegistryContactDto,
  RecordBlockedDto,
  RegistryBlockedDto,
  SessionReplyStatsDto,
} from './dto/registry.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('Registry')
@Controller('registry')
export class RegistryController {
  constructor(private readonly registry: RegistryService) {}

  @Post('contacts/import')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary:
      'Bulk-import contacts into the local lead registry, deduplicating against existing saved ' +
      'contacts (a number already saved is never double-saved). Optionally skips numbers already ' +
      'in the WhatsApp addressbook and/or mirror-saves new numbers into a session addressbook.',
  })
  @ApiResponse({ status: 201, description: 'Import result', type: ImportContactsResultDto })
  @HttpCode(HttpStatus.CREATED)
  importContacts(@Body() dto: ImportContactsDto): Promise<ImportContactsResultDto> {
    return this.registry.importContacts(dto);
  }

  @Get('contacts')
  @ApiOperation({
    summary:
      'List local registry contacts annotated with reply status (whether any session received an ' +
      'incoming message from that number) from the persisted message store.',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Max rows, default 500.' })
  @ApiResponse({ status: 200, description: 'Contacts with reply flags', type: [RegistryContactDto] })
  listContacts(@Query('limit') limit?: string): Promise<RegistryContactDto[]> {
    return this.registry.listContacts(limit ? Math.max(1, parseInt(limit, 10) || 500) : 500);
  }

  @Post('blocked')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Record a number that blocked (or reported) us into the durable registry.' })
  @ApiResponse({ status: 201, description: 'Recorded', type: RegistryBlockedDto })
  @HttpCode(HttpStatus.CREATED)
  recordBlocked(@Body() dto: RecordBlockedDto): Promise<RegistryBlockedDto> {
    if (dto.kind === undefined) dto.kind = 'blocked';
    return this.registry.recordBlocked(dto);
  }

  @Get('blocked')
  @ApiOperation({
    summary:
      'List the blocked/reported registry, plus the live engine blocklists (numbers we blocked ' +
      'per session) when includeEngine is on.',
  })
  @ApiQuery({ name: 'includeEngine', required: false, description: 'Union live engine blocklists, default true.' })
  @ApiResponse({ status: 200, description: 'Blocked/reported registry and engine blocklist.' })
  async listBlocked(@Query('includeEngine') includeEngine?: string) {
    return this.registry.listBlocked(includeEngine === 'false' ? false : true);
  }

  @Delete('blocked/:phone')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Remove a number from the blocked/reported registry.' })
  @ApiResponse({ status: 200 })
  removeBlocked(@Param('phone') phone: string, @Query('kind') kind?: string): Promise<{ removed: boolean }> {
    const k = kind === 'reported' ? 'reported' : kind === 'blocked' ? 'blocked' : undefined;
    return this.registry.removeBlocked(phone, k);
  }

  @Get('replies')
  @ApiOperation({
    summary:
      'Per-session reply analytics: recipients sent to, distinct numbers that replied (incoming), ' +
      'reply rate, and blocked/reported counts — the "did they reply?" dashboard panel.',
  })
  @ApiResponse({ status: 200, description: 'Per-session reply stats', type: [SessionReplyStatsDto] })
  sessionReplies(): Promise<SessionReplyStatsDto[]> {
    return this.registry.sessionReplyStats();
  }
}

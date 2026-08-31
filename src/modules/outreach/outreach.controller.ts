import { Controller, Get, Post, Delete, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { OutreachService } from './outreach.service';
import {
  CreateOutreachCampaignDto,
  OutreachCampaignResponseDto,
} from './dto/outreach-campaign.dto';

@ApiTags('Outreach')
@Controller('outreach/campaigns')
export class OutreachController {
  constructor(private readonly outreach: OutreachService) {}

  @Post()
  @ApiOperation({
    summary:
      'Create a multi-session round-robin outreach campaign. Allocates the contact list across the ' +
      'given session pool (balanced, warm-up-capped), split into bursts separated by cool-downs.',
  })
  @ApiResponse({ status: 201, type: OutreachCampaignResponseDto })
  create(@Body() dto: CreateOutreachCampaignDto): Promise<OutreachCampaignResponseDto> {
    return this.outreach.create(dto);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a scheduled campaign (begins dispatching round-robin bursts).' })
  @ApiResponse({ status: 200, type: OutreachCampaignResponseDto })
  start(@Param('id') id: string): Promise<OutreachCampaignResponseDto> {
    return this.outreach.start(id);
  }

  @Post(':id/stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop a running campaign and cancel its in-flight batches.' })
  @ApiResponse({ status: 200, type: OutreachCampaignResponseDto })
  stop(@Param('id') id: string): Promise<OutreachCampaignResponseDto> {
    return this.outreach.stop(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a campaign status and per-session progress.' })
  @ApiResponse({ status: 200, type: OutreachCampaignResponseDto })
  status(@Param('id') id: string): Promise<OutreachCampaignResponseDto> {
    return this.outreach.status(id);
  }

  @Get(':id/execution')
  @ApiOperation({
    summary:
      'Campaign execution report: per-recipient sent/failed/pending results from all batch statuses.',
  })
  @ApiResponse({ status: 200 })
  execution(@Param('id') id: string) {
    return this.outreach.executionReport(id);
  }

  @Get()
  @ApiOperation({ summary: 'List all outreach campaigns (newest first).' })
  @ApiResponse({ status: 200, type: [OutreachCampaignResponseDto] })
  list(): Promise<OutreachCampaignResponseDto[]> {
    return this.outreach.list();
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a campaign (must not be running).' })
  @ApiResponse({ status: 200 })
  remove(@Param('id') id: string): Promise<{ deleted: boolean }> {
    return this.outreach.remove(id);
  }
}

import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CreditService } from './credit.service';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { IsString, IsOptional, IsNumber, MinLength } from 'class-validator';

class CreateCreditTemplateDto {
  @IsString() @MinLength(1) name!: string;
  @IsString() body!: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsNumber() creditCost?: number;
  @IsOptional() @IsString() mediaUrl?: string;
  @IsOptional() @IsString() mimetype?: string;
}

@ApiTags('credits')
@Controller('credits')
export class CreditController {
  constructor(private readonly creditService: CreditService) {}

  @Get('templates')
  @ApiOperation({ summary: 'List credit message templates (admin editable, per-message credit)' })
  async list() {
    return this.creditService.list();
  }

  @Post('templates')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create credit template (admin only)' })
  async create(@Body() dto: CreateCreditTemplateDto) {
    return this.creditService.create(dto);
  }

  @Put('templates/:id')
  @RequireRole(ApiKeyRole.ADMIN)
  async update(@Param('id') id: string, @Body() dto: Partial<CreateCreditTemplateDto>) {
    return this.creditService.update(id, dto as any);
  }

  @Delete('templates/:id')
  @RequireRole(ApiKeyRole.ADMIN)
  async remove(@Param('id') id: string) {
    await this.creditService.remove(id);
    return { deleted: true };
  }
}

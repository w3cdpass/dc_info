import { Controller, Post, Get, Delete, Body, Param, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { Request } from 'express';
import { ResellerService } from './reseller.service';
import { CurrentApiKey, RequireRole } from './decorators/auth.decorators';
import { Public } from './decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { IsEmail, IsString, MinLength, IsOptional, IsNumber } from 'class-validator';

class CreateResellerDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(3) password!: string;
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsNumber() credits?: number;
  @IsOptional() creditCost?: Record<string, number>;
}

class ResellerLoginDto {
  @IsEmail() email!: string;
  @IsString() password!: string;
}

@ApiTags('reseller')
@Controller('auth/reseller')
export class ResellerController {
  constructor(private readonly resellerService: ResellerService) {}

  @Post('create')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create reseller/demo user with email/password (admin only, demo gets credits)' })
  async create(@Body() dto: CreateResellerDto, @Req() req: Request, @CurrentApiKey() actor?: ApiKey) {
    const actorEmail =
      (req as any).adminEmail ||
      (actor as any)?.email ||
      ((req.headers as any)['x-admin-email'] as string | undefined) ||
      undefined;
    // Also try sessionStorage email is not available server-side; frontend sends x-admin-email header
    const headerEmail = (req.headers['x-admin-email'] as string) || actorEmail;
    // Fallback to checking if actor is demo: only admin can create
    const result = await this.resellerService.createDemoUser(dto, headerEmail || 'infyle@infyle.com');
    return {
      id: result.user.id,
      email: result.user.email,
      role: result.user.role,
      apiKey: result.rawKey,
      credits: result.user.credits,
    };
  }

  @Post('login')
  @Public()
  @ApiOperation({ summary: 'Demo user login with email/password -> returns apiKey' })
  async login(@Body() dto: ResellerLoginDto) {
    const res = await this.resellerService.verify(dto.email, dto.password);
    if (!res) throw new Error('Invalid email or password');
    return {
      success: true,
      email: res.user.email,
      role: res.user.role,
      apiKey: res.rawKey,
      credits: res.user.credits,
      apiKeyId: res.user.apiKeyId,
    };
  }

  @Get('list')
  @RequireRole(ApiKeyRole.ADMIN)
  async list() {
    return this.resellerService.list();
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  async remove(@Param('id') id: string) {
    await this.resellerService.delete(id);
    return { deleted: true };
  }
}

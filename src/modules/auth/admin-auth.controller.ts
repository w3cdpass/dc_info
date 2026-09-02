import { Body, Controller, Get, HttpCode, HttpStatus, Post, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import * as fs from 'fs';
import * as path from 'path';
import { Public } from './decorators/auth.decorators';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from './auth.service';
import { ResellerService } from './reseller.service';
import { readBootstrapKey } from './bootstrap-key-file';

import { IsEmail, IsString, MinLength } from 'class-validator';

class AdminLoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

@ApiTags('admin-auth')
@Controller('auth/admin')
export class AdminAuthController {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly authService: AuthService,
    private readonly resellerService: ResellerService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin login with email/password (hardcoded + Supabase admin_users)' })
  @ApiResponse({ status: 200, description: 'Login success with API key for subsequent requests' })
  async login(@Body() dto: AdminLoginDto) {
    const email = (dto.email || '').trim();
    const password = (dto.password || '').trim();
    if (!email || !password) {
      throw new UnauthorizedException('Email and password are required');
    }

    const admin = await this.supabaseService.verifyAdminCredentials(email, password);
    // Fallback to reseller/demo users (local DB) — allows demo login via same form with username/password
    if (!admin) {
      const reseller = await this.resellerService.verifyResellerCredentials(email, password);
      if (reseller) {
        // Return the reseller's own API key
        const ru = await this.resellerService.findByEmail(email);
        const rawKey = ru?.apiKeyRaw || null;
        return {
          success: true,
          admin: { id: reseller.id, email: reseller.email, role: reseller.role },
          apiKey: rawKey,
          message: rawKey ? 'Login successful' : 'Login successful — api key missing, contact admin',
        };
      }
      throw new UnauthorizedException('Invalid email or password');
    }

    // Return an API key for subsequent authenticated requests.
    // Prefer the existing bootstrap admin key so the dashboard can keep using X-API-Key header.
    let apiKey: string | null = null;
    try {
      const raw = readBootstrapKey({ warn: () => {} });
      if (raw) apiKey = raw;
      if (!apiKey) {
        const p = path.resolve(process.cwd(), 'data', '.api-key');
        if (fs.existsSync(p)) apiKey = fs.readFileSync(p, 'utf8').trim() || null;
      }
    } catch {
      apiKey = null;
    }

    return {
      success: true,
      admin: { id: admin.id, email: admin.email, role: admin.role },
      // Frontend will store this as openwa_api_key for all subsequent API calls
      apiKey,
      message: apiKey ? 'Login successful' : 'Login successful — please set API key manually in dashboard',
    };
  }

  @Get('me')
  @Public()
  @ApiOperation({ summary: 'List admin users (requires Supabase)' })
  async listAdmins() {
    const admins = await this.supabaseService.listAdminUsers();
    const hardcoded = this.supabaseService.getHardcodedAdmin();
    return {
      hardcoded: { email: hardcoded.email, role: hardcoded.role },
      supabaseConfigured: this.supabaseService.isConfigured(),
      admins,
    };
  }
}

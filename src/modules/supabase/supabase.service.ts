import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

let supabaseJs: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  supabaseJs = require('@supabase/supabase-js');
} catch {
  supabaseJs = null;
}

export interface AdminUser {
  id: string;
  email: string;
  role: string;
  is_active: boolean;
  created_at?: string;
  last_login_at?: string | null;
}

const HARDCODED_ADMIN = {
  email: 'infyle@infyle.com',
  password: 'infyle@90',
  role: 'super_admin' as const,
};

@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);
  private client: any = null;
  private configured = false;

  constructor(private readonly configService: ConfigService) {
    const url =
      this.configService.get<string>('SUPABASE_URL') ||
      this.configService.get<string>('NEXT_PUBLIC_SUPABASE_URL') ||
      process.env.SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      'https://npjarhgwmdhwnioqlxdk.supabase.co';

    const anonKey =
      this.configService.get<string>('SUPABASE_ANON_KEY') ||
      this.configService.get<string>('NEXT_PUBLIC_SUPABASE_ANON_KEY') ||
      this.configService.get<string>('SUPABASE_PUBLISHABLE_KEY') ||
      this.configService.get<string>('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY') ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      // Fallback to the anon JWT the user provided (safe to keep as fallback for dev)
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wamFyaGd3bWRod25pb3FseGRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxNzA3NzQsImV4cCI6MjEwMzc0Njc3NH0.i1JKhyaJbHYN1D9gX3tnN9ao2oljbLoKxaK9DIeXBsU';

    const serviceKey =
      this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY') || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseJs) {
      this.logger.warn('Supabase client not installed — run npm install @supabase/supabase-js');
      return;
    }

    if (!url) {
      this.logger.warn('Supabase URL not configured — admin DB features disabled');
      return;
    }

    try {
      const keyToUse = serviceKey || anonKey;
      if (!keyToUse) {
        this.logger.warn('Supabase key not configured — admin DB features disabled');
        return;
      }
      this.client = supabaseJs.createClient(url, keyToUse, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      this.configured = true;
      this.logger.log(`Supabase client configured for ${url}`);
    } catch (e) {
      this.logger.warn(`Failed to configure Supabase client: ${String(e)}`);
    }
  }

  isConfigured(): boolean {
    return this.configured && !!this.client;
  }

  getClient(): any {
    return this.client;
  }

  getHardcodedAdmin() {
    return HARDCODED_ADMIN;
  }

  /**
   * Verify admin credentials.
   * 1. Hardcoded check always passes (infyle@infyle.com / infyle@90) — no DB needed
   * 2. If Supabase is configured, also check admin_users table (supports additional admins)
   */
  async verifyAdminCredentials(email: string, password: string): Promise<AdminUser | null> {
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedPassword = password.trim();

    // 1) Hardcoded super admin — always works even if Supabase is down
    if (normalizedEmail === HARDCODED_ADMIN.email.toLowerCase() && normalizedPassword === HARDCODED_ADMIN.password) {
      return {
        id: 'hardcoded-admin',
        email: HARDCODED_ADMIN.email,
        role: HARDCODED_ADMIN.role,
        is_active: true,
      };
    }

    // 2) Supabase admin_users table lookup (optional)
    if (!this.isConfigured()) {
      return null;
    }

    try {
      const { data, error } = await this.client
        .from('admin_users')
        .select('id, email, role, is_active, created_at, last_login_at, password_hash')
        .eq('email', normalizedEmail)
        .eq('is_active', true)
        .maybeSingle();

      if (error) {
        this.logger.warn(`Supabase admin lookup failed: ${error.message}`);
        return null;
      }
      if (!data) return null;

      // Support both plain and hashed passwords. Try plain first, then bcrypt if available.
      const stored = data.password_hash as string | undefined;
      if (!stored) return null;

      let isValid = false;
      if (stored === normalizedPassword) {
        isValid = true;
      } else {
        // Try bcrypt comparison if hash looks like bcrypt
        if (stored.startsWith('$2a$') || stored.startsWith('$2b$')) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const bcrypt = require('bcryptjs');
            isValid = await bcrypt.compare(normalizedPassword, stored);
          } catch {
            isValid = false;
          }
        }
      }

      if (!isValid) return null;

      // Update last_login_at (best effort)
      void this.client
        .from('admin_users')
        .update({ last_login_at: new Date().toISOString() })
        .eq('id', data.id)
        .then(() => {});

      return {
        id: data.id,
        email: data.email,
        role: data.role || 'admin',
        is_active: true,
        created_at: data.created_at,
        last_login_at: data.last_login_at,
      };
    } catch (e) {
      this.logger.warn(`verifyAdminCredentials error: ${String(e)}`);
      return null;
    }
  }

  async listAdminUsers(): Promise<AdminUser[]> {
    if (!this.isConfigured()) return [];
    try {
      const { data, error } = await this.client
        .from('admin_users')
        .select('id, email, role, is_active, created_at, last_login_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data as AdminUser[]) || [];
    } catch (e) {
      this.logger.warn(`listAdminUsers failed: ${String(e)}`);
      return [];
    }
  }
}

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Supabase credentials — provided by user. Fallback to env for flexibility.
// NEXT_PUBLIC_* is the canonical name; VITE_* is the Vite-exposed equivalent.
const SUPABASE_URL =
  (import.meta as any).env?.VITE_SUPABASE_URL ||
  (import.meta as any).env?.NEXT_PUBLIC_SUPABASE_URL ||
  'https://npjarhgwmdhwnioqlxdk.supabase.co';

const SUPABASE_ANON_KEY =
  (import.meta as any).env?.VITE_SUPABASE_ANON_KEY ||
  (import.meta as any).env?.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  (import.meta as any).env?.VITE_SUPABASE_PUBLISHABLE_KEY ||
  (import.meta as any).env?.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wamFyaGd3bWRod25pb3FseGRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxNzA3NzQsImV4cCI6MjEwMzc0Njc3NH0.i1JKhyaJbHYN1D9gX3tnN9ao2oljbLoKxaK9DIeXBsU';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (client) return client;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return client;
  } catch {
    return null;
  }
}

export const HARDCODED_ADMIN = {
  email: 'infyle@infyle.com',
  password: 'infyle@90',
} as const;

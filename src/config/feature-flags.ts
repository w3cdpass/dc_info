import { ConfigService } from '@nestjs/config';

/**
 * Runtime feature flags, centralised so every flag's env-var name and default lives in one place
 * instead of being read inline from `process.env` at each call site. Surfaced through
 * `ConfigService` as `features.*` (see `configuration.ts`) and their canonical boolean values are
 * validated at boot (see `env.validation.ts`).
 */
export interface FeatureFlags {
  /** Auto-start previously-authenticated sessions on boot. Opt-in — default OFF. */
  autoStartSessions: boolean;
  /** Persist + dispatch incoming disappearing-message-timer messages. Default ON. */
  storeEphemeralMessages: boolean;
  /** Inline @lid -> phone resolution for inbound privacy-id senders. Opt-in — default OFF. */
  resolveLidToPhone: boolean;
  /** Humanising typing indicator before single (non-bulk) sends. Default ON. */
  simulateTyping: boolean;
  /** Upper bound (ms) on the humanising typing pause. Default 5000. */
  simulateTypingMaxMs: number;
  /** Humanising typing indicator before each bulk (batch) send. Default ON. */
  bulkTypingEnabled: boolean;
  /** Default lower bound (ms) of the per-message delay between bulk sends. Default 30000. */
  bulkDelayMinMs: number;
  /** Default upper bound (ms) of the per-message delay between bulk sends. Default 120000. */
  bulkDelayMaxMs: number;
  /** Default for the per-batch `askForReply` option (append a soft reply CTA). Default OFF. */
  bulkAskForReplyDefault: boolean;
  /**
   * Safety cap: a batch whose SAME text body is sent to more than this many recipients with no
   * per-recipient variables is refused (the "identical string to 100% of recipients" spam trap).
   * 0 disables the guard. Default 5.
   */
  bulkMinSpreadRecipients: number;
  /** Optional text appended when `askForReply` is enabled on a text send. */
  bulkAskForReplyCta: string;
  /** Default for the per-batch `preCheckNumbers` (resolve + drop unregistered recipients). Opt-in — default OFF. */
  bulkPreCheckNumbersDefault: boolean;
  /** Default for the per-batch `saveContactFirst` (add each recipient to the addressbook before sending). Opt-in — default OFF. */
  bulkSaveContactFirstDefault: boolean;
}

/**
 * Derive the feature-flag set from an environment map. Pure and parameterised for testability. The
 * comparisons intentionally mirror the exact semantics of the original inline reads so behaviour is
 * unchanged:
 *   - `=== 'true'`  → opt-in flag (default false)
 *   - `!== 'false'` → opt-out flag (default true)
 * and the max-ms parse mirrors the original `Number(x) || 5000` — 0, negative, empty and non-numeric
 * values all fall back to 5000 (note this differs from `parseInt`, which would keep a literal 0).
 */
export function computeFeatureFlags(env: NodeJS.ProcessEnv = process.env): FeatureFlags {
  return {
    autoStartSessions: env.AUTO_START_SESSIONS === 'true',
    storeEphemeralMessages: env.STORE_EPHEMERAL_MESSAGES !== 'false',
    resolveLidToPhone: env.RESOLVE_LID_TO_PHONE === 'true',
    simulateTyping: env.SIMULATE_TYPING !== 'false',
    simulateTypingMaxMs: Number(env.SIMULATE_TYPING_MAX_MS) || 5000,
    bulkTypingEnabled: env.BULK_TYPING_ENABLED !== 'false',
    bulkDelayMinMs: Number(env.BULK_DELAY_MIN_MS) || 30000,
    bulkDelayMaxMs: Number(env.BULK_DELAY_MAX_MS) || 120000,
    bulkAskForReplyDefault: env.BULK_ASK_FOR_REPLY_DEFAULT === 'true',
    bulkMinSpreadRecipients: Number(env.BULK_MIN_SPREAD_RECIPIENTS) || 5,
    bulkAskForReplyCta: env.BULK_ASK_FOR_REPLY_CTA || 'Reply YES to continue.',
    bulkPreCheckNumbersDefault: env.BULK_PRE_CHECK_NUMBERS_DEFAULT === 'true',
    bulkSaveContactFirstDefault: env.BULK_SAVE_CONTACT_FIRST_DEFAULT === 'true',
  };
}

/**
 * Resolve the flags, preferring the `ConfigService`-loaded set (the boot-time snapshot built by
 * `configuration.ts`) and falling back to a live `process.env` read when `ConfigService` is absent —
 * e.g. a unit test that constructs a service without the global `ConfigModule`. Environment variables
 * do not change during a process's lifetime, so the snapshot and a live read are equivalent in
 * production; the fallback exists purely to preserve the live-read behaviour that unit tests rely on
 * when they mutate `process.env`.
 */
export function resolveFeatureFlags(configService?: Pick<ConfigService, 'get'>): FeatureFlags {
  const fromConfig = configService?.get<FeatureFlags>('features');
  return fromConfig ?? computeFeatureFlags();
}

import dotenv from 'dotenv';

/**
 * Values in .env win over variables already set in the system environment.
 * Without this, a variable of the same name left over from another project (set at
 * Windows or shell level) would silently be used instead of this project's .env.
 * Tests keep their own fixed environment, and evals lock the few settings they pin.
 */
const locked = new Set((process.env.CONFIG_LOCKED_KEYS ?? '').split(',').filter(Boolean));
const fromFile = dotenv.config({ quiet: true }).parsed ?? {};
/** Names of variables whose system value was replaced by a different value from .env. */
export const envOverrides: string[] = [];
if (!process.env.VITEST) {
  for (const [key, value] of Object.entries(fromFile)) {
    if (locked.has(key)) continue;
    if (process.env[key] !== undefined && process.env[key] !== value) envOverrides.push(key);
    process.env[key] = value;
  }
}

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function int(name: string, fallback: number): number {
  const v = Number.parseInt(str(name), 10);
  return Number.isFinite(v) ? v : fallback;
}

const googleCalendarId = str('GOOGLE_CALENDAR_ID');
const googleSheetId = str('GOOGLE_SHEET_ID');
const explicitStore = str('STORE').toLowerCase();

export const config = {
  port: int('PORT', 3000),

  geminiApiKey: str('GEMINI_API_KEY'),
  geminiModel: str('GEMINI_MODEL', 'gemini-3.5-flash'),
  /** Minimum gap between model requests in ms (0 = none). For the free tier's per-minute limit. */
  llmMinIntervalMs: Math.max(0, int('LLM_MIN_INTERVAL_MS', 0)),

  /** Where appointments and contacts live. */
  store: (explicitStore === 'google' || explicitStore === 'memory'
    ? explicitStore
    : googleCalendarId && googleSheetId
      ? 'google'
      : 'memory') as 'google' | 'memory',
  googleCalendarId,
  googleSheetId,
  googleCredentialsFile: str('GOOGLE_APPLICATION_CREDENTIALS'),
  googleCredentialsB64: str('GOOGLE_SERVICE_ACCOUNT_B64'),

  /** Empty means: follow the Google Calendar's own timezone (or Los Angeles in demo mode). */
  shopTimezone: str('SHOP_TIMEZONE'),
  /** Country calling code assumed for 10-digit numbers. */
  defaultCountryCode: str('DEFAULT_COUNTRY_CODE', '1').replace(/\D/g, '') || '1',
  shopBays: Math.max(1, int('SHOP_BAYS', 1)),

  vapiApiKey: str('VAPI_API_KEY'),
  publicUrl: str('PUBLIC_URL').replace(/\/+$/, ''),
  vapiWebhookSecret: str('VAPI_WEBHOOK_SECRET'),
  vapiAssistantId: str('VAPI_ASSISTANT_ID'),
  vapiModel: str('VAPI_MODEL', 'gpt-4.1-mini'),
  vapiVoiceProvider: str('VAPI_VOICE_PROVIDER', 'vapi'),
  vapiVoiceId: str('VAPI_VOICE_ID', 'Savannah'),
  vapiVoiceModel: str('VAPI_VOICE_MODEL') || undefined,
  vapiTranscriberModel: str('VAPI_TRANSCRIBER_MODEL', 'nova-3'),
  humanTransferNumber: str('HUMAN_TRANSFER_NUMBER') || undefined,
};

export type Config = typeof config;

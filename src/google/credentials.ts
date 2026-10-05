import { existsSync } from 'node:fs';
import { config } from '../config.js';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
];

/** GoogleAuth options for the configured service account. */
export function googleAuthOptions(): { scopes: string[]; keyFile?: string; credentials?: Record<string, unknown> } {
  if (config.googleCredentialsB64) {
    let credentials: Record<string, unknown>;
    try {
      credentials = JSON.parse(Buffer.from(config.googleCredentialsB64, 'base64').toString('utf8'));
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_B64 is not valid base64-encoded JSON.');
    }
    return { scopes: GOOGLE_SCOPES, credentials };
  }
  if (config.googleCredentialsFile) {
    if (!existsSync(config.googleCredentialsFile)) {
      throw new Error(
        `Service-account key not found at ${config.googleCredentialsFile}. ` +
          'Set GOOGLE_APPLICATION_CREDENTIALS to the JSON key path (see README, "Google setup").',
      );
    }
    return { scopes: GOOGLE_SCOPES, keyFile: config.googleCredentialsFile };
  }
  throw new Error(
    'No Google credentials configured. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_B64, or run with STORE=memory.',
  );
}

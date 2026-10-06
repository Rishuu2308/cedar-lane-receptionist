/** Entry point: `npm run dev` / `npm start`. */
import { createApp } from './app.js';
import { GoogleCalendar } from './calendar/google.js';
import { config, envOverrides } from './config.js';
import { resolveShopTimezone } from './google/timezone.js';
import { createServer } from './server.js';
import { SHOP } from './shop.js';
import { WEBHOOK_PATH } from './vapi/assistant.js';

async function main() {
  const app = createApp({ idleSummaryMs: 15_000 });
  let zoneSource = config.shopTimezone ? 'SHOP_TIMEZONE' : 'default';
  if (app.storeMode === 'google') {
    // Fail at startup, with a readable message, if Google is not reachable or not shared.
    zoneSource = (await resolveShopTimezone(app.calendar instanceof GoogleCalendar ? app.calendar : undefined)).source;
    await app.contacts.ensureSchema();
    await app.calendar.prewarm?.();
  }
  const server = createServer(app);
  // Write the final log entry for chats idle for ten minutes; forget them after six hours.
  setInterval(() => void app.agent?.sweep(10 * 60_000, 6 * 60 * 60_000), 60_000).unref();

  if (envOverrides.length) {
    console.log(
      `Note: ${envOverrides.join(', ')} ${envOverrides.length === 1 ? 'is' : 'are'} also set in your system environment with a different value. Using the value from .env.`,
    );
  }

  server.listen(config.port, (err?: Error) => {
    if (err) {
      console.error(`Could not start on port ${config.port}: ${err.message}`);
      process.exit(1);
    }
    console.log(`${SHOP.name} receptionist listening on http://localhost:${config.port}`);
    console.log(`  store: ${app.storeMode}${app.storeMode === 'memory' ? ' (demo data, nothing is written to Google)' : ''}`);
    console.log(`  chat model: ${app.llm ? config.geminiModel : 'NOT CONFIGURED (set GEMINI_API_KEY)'}`);
    console.log(`  shop time: ${app.clock().toFormat('cccc, LLL d, h:mm a')} ${SHOP.timezone} (timezone from ${zoneSource})`);
    console.log(`  Vapi webhook: ${config.publicUrl || 'http://localhost:' + config.port}${WEBHOOK_PATH}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

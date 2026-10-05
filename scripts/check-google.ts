/**
 * Verifies the Google setup end to end before you run anything else:
 *   npm run check:google
 * Checks credentials, that the calendar can be read and written, and that the
 * sheet can be read and written. Leaves nothing behind.
 */
import { readFileSync } from 'node:fs';
import { GoogleCalendar } from '../src/calendar/google.js';
import { config } from '../src/config.js';
import { GoogleContacts } from '../src/contacts/google.js';
import { resolveShopTimezone } from '../src/google/timezone.js';
import { systemClock } from '../src/time.js';

function serviceAccountEmail(): string {
  try {
    const raw = config.googleCredentialsB64
      ? Buffer.from(config.googleCredentialsB64, 'base64').toString('utf8')
      : readFileSync(config.googleCredentialsFile, 'utf8');
    return JSON.parse(raw).client_email ?? '(no client_email in key)';
  } catch {
    return '(could not read the key file)';
  }
}

async function step(label: string, fn: () => Promise<string>): Promise<boolean> {
  try {
    console.log(`OK    ${label}: ${await fn()}`);
    return true;
  } catch (err) {
    const e = err as { message?: string; code?: number };
    console.log(`FAIL  ${label}: ${e.message ?? err}`);
    if (e.code === 404) console.log('      -> The ID is wrong, or it is not shared with the service account.');
    if (e.code === 403) console.log('      -> Share it with the service account (calendar: "Make changes to events"; sheet: "Editor"), and enable the API in Google Cloud.');
    return false;
  }
}

async function main() {
  const email = serviceAccountEmail();
  console.log(`Service account: ${email}`);
  console.log(`Calendar ID:     ${config.googleCalendarId || '(not set)'}`);
  console.log(`Sheet ID:        ${config.googleSheetId || '(not set)'}\n`);
  if (!config.googleCalendarId || !config.googleSheetId) {
    console.log('Set GOOGLE_CALENDAR_ID and GOOGLE_SHEET_ID in .env first.');
    process.exit(1);
  }

  const calendar = new GoogleCalendar(config.googleCalendarId);
  const contacts = new GoogleContacts(config.googleSheetId);
  const results: boolean[] = [];

  results.push(
    await step('Calendar timezone', async () => {
      const calendarZone = await calendar.getTimeZone();
      const tz = await resolveShopTimezone(calendar);
      if (calendarZone && calendarZone !== tz.zone) {
        return (
          `the agent will use ${tz.zone} (SHOP_TIMEZONE) but the calendar displays in ${calendarZone}. ` +
          'Bookings are stored correctly, but will look shifted in the calendar. Remove SHOP_TIMEZONE to follow the calendar.'
        );
      }
      return `${tz.zone} (from ${tz.source})`;
    }),
  );
  const now = systemClock();

  results.push(
    await step('Calendar read', async () => {
      const events = await calendar.listEvents(now.toUTC().toISO()!, now.plus({ days: 7 }).toUTC().toISO()!, { fresh: true });
      return `${events.length} event(s) in the next 7 days`;
    }),
  );
  results.push(
    await step('Calendar write', async () => {
      const start = now.plus({ years: 1 }).startOf('hour');
      const ev = await calendar.createEvent({
        start: start.toUTC().toISO()!,
        end: start.plus({ minutes: 30 }).toUTC().toISO()!,
        summary: 'Receptionist setup check (safe to delete)',
        description: '',
        busy: false,
        props: { setupCheck: '1' },
      });
      await calendar.deleteEvent(ev.id);
      return 'created and removed a test event';
    }),
  );
  results.push(
    await step('Sheet read/write', async () => {
      await contacts.ensureSchema();
      return '"Contacts" and "Call Log" tabs are in place with headers';
    }),
  );

  if (results.every(Boolean)) {
    console.log('\nAll good. Next: npm run seed, then npm run dev.');
  } else {
    console.log(`\nFix the failures above. Most often the calendar or sheet has not been shared with ${email}.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

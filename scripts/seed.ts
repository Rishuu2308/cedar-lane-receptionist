/**
 * Puts test data into the real Google Calendar and Sheet:
 *   npm run seed
 * Safe to re-run: events from an earlier seed are removed first, and contacts are
 * updated in place. Events you or the agent created are left alone.
 */
import { GoogleCalendar } from '../src/calendar/google.js';
import { config } from '../src/config.js';
import { GoogleContacts } from '../src/contacts/google.js';
import { resolveShopTimezone } from '../src/google/timezone.js';
import { SEED_PROP, describeSeed, seedContacts, seedEvents } from '../src/seed-data.js';
import { systemClock } from '../src/time.js';

async function main() {
  if (!config.googleCalendarId || !config.googleSheetId) {
    throw new Error('Set GOOGLE_CALENDAR_ID and GOOGLE_SHEET_ID in .env first (see README, "Google setup").');
  }
  const calendar = new GoogleCalendar(config.googleCalendarId);
  const contacts = new GoogleContacts(config.googleSheetId);
  const tz = await resolveShopTimezone(calendar);
  console.log(`Shop timezone: ${tz.zone} (from ${tz.source}).`);
  const now = systemClock();

  const old = await calendar.findByProp(SEED_PROP, '1', now.minus({ days: 30 }).toUTC().toISO()!);
  for (const ev of old) await calendar.deleteEvent(ev.id);
  console.log(`Removed ${old.length} previously seeded event(s).`);

  const events = seedEvents(now);
  for (const ev of events) await calendar.createEvent(ev);
  console.log(`Created ${events.length} calendar event(s).`);

  await contacts.ensureSchema();
  const rows = seedContacts(now);
  for (const c of rows) {
    const existing = await contacts.getContact(c.phone);
    // Keep any history the agent has already written for this caller.
    await contacts.saveContact(existing ? { ...existing, name: c.name, vehicle: c.vehicle } : c);
  }
  console.log(`Sheet ready: "Contacts" and "Call Log" tabs, ${rows.length} sample contact(s).`);

  console.log('\nWhat is on the calendar now:');
  for (const line of describeSeed(now)) console.log(`  - ${line}`);
}

main().catch((err) => {
  console.error(`Seed failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

/** Cases found in review that the main suites did not cover. */
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MemoryCalendar } from '../src/calendar/memory.js';
import type { CalEvent } from '../src/calendar/types.js';
import { MemoryContacts } from '../src/contacts/memory.js';
import { seedEvents, seedThursday } from '../src/seed-data.js';
import { createServer } from '../src/server.js';
import { fixedClock, hhmm, isoDate, normalizePhone } from '../src/time.js';
import { MONDAY_10AM, ScriptedLlm, at, makeApp } from './helpers.js';

const JORDAN = '+14155550177';

describe('chat sessions', () => {
  it('keeps the conversation when an idle chat is finalised and then resumes', async () => {
    const llm = new ScriptedLlm([{ text: 'reply' }]);
    const app = makeApp({ llm });
    const agent = app.agent!;
    await agent.respond('s', 'Is 4:30 Thursday open?');
    await agent.sweep(0, 60_000); // idle long enough to finalise, not long enough to forget
    expect(app.contacts.callLog[0]).toMatchObject({ callId: 's', status: 'ended' });

    await agent.respond('s', 'Sara, 415-555-0190.');
    const sent = llm.calls.at(-1)!.messages.filter((m) => m.role === 'user').map((m) => (m as { content: string }).content);
    expect(sent).toEqual(['Is 4:30 Thursday open?', 'Sara, 415-555-0190.']);

    // The call was reopened, so ending it again writes a fresh summary over the same row.
    await agent.end('s');
    expect(llm.jsonCalls).toHaveLength(2);
    expect(llm.jsonCalls[1].user).toContain('Sara, 415-555-0190.');
    expect(app.contacts.callLog).toHaveLength(1);
  });

  it('forgets a chat only after the longer limit', async () => {
    const app = makeApp({ llm: new ScriptedLlm([{ text: 'reply' }]) });
    await app.agent!.respond('s', 'hello');
    await app.agent!.sweep(0, 0);
    expect(app.agent!.session('s').messages).toHaveLength(0);
  });

  it('does not store an empty model turn', async () => {
    const llm = new ScriptedLlm([{ text: '' }]);
    const app = makeApp({ llm });
    const out = await app.agent!.respond('s', 'hello');
    expect(out.reply).toContain('trouble');
    const stored = app.agent!.session('s').messages;
    expect(stored.every((m) => m.role !== 'assistant' || (m.content ?? '').length > 0)).toBe(true);
  });
});

describe('writes that fail part-way', () => {
  /** A calendar whose reads start failing right after the first successful write. */
  class FlakyAfterWrite extends MemoryCalendar {
    wrote = false;
    override async createEvent(...args: Parameters<MemoryCalendar['createEvent']>) {
      const ev = await super.createEvent(...args);
      this.wrote = true;
      return ev;
    }
    override async updateEvent(...args: Parameters<MemoryCalendar['updateEvent']>) {
      const ev = await super.updateEvent(...args);
      this.wrote = true;
      return ev;
    }
    override async listEvents(from: string, to: string): Promise<CalEvent[]> {
      if (this.wrote) {
        this.wrote = false; // fail once
        throw new Error('503 from Google');
      }
      return super.listEvents(from, to);
    }
  }

  it('reports a booking as booked when only the follow-up verification read fails', async () => {
    const clock = fixedClock(MONDAY_10AM);
    const calendar = new FlakyAfterWrite(seedEvents(clock()));
    const contacts = new MemoryContacts();
    const app = createApp({ clock, calendar, contacts, llm: null });
    const res = await app.tools.execute(
      'book_appointment',
      { service: 'express_wash', date: 'Tuesday', time: '10:00', customer_name: 'Sara', phone: '415-555-0190' },
      { callId: 'c1', channel: 'chat' },
    );
    expect(res).toMatchObject({ ok: true, booked: true });
    expect(calendar.all().some((e) => e.props.phone === '+14155550190')).toBe(true);
    await app.tracker.flush();
    expect(contacts.callLog[0].actions).toContain('Booked Express Wash');
  });

  it('reports a reschedule as done when only the verification read fails', async () => {
    const clock = fixedClock(MONDAY_10AM);
    const calendar = new FlakyAfterWrite(seedEvents(clock()));
    const app = createApp({ clock, calendar, contacts: new MemoryContacts(), llm: null });
    const [appt] = await app.scheduler.findUpcomingByPhone('+14155550142');
    const res = await app.scheduler.reschedule({ appointmentId: appt.id, phone: '+14155550142', newStart: at('2026-10-06', '14:00') });
    expect(res).toMatchObject({ ok: true, unchanged: false });
  });
});

describe('running late, said after the appointment time', () => {
  it('measures "ten minutes" from now when the start time has already gone', async () => {
    const { scheduler } = makeApp({ now: '2026-10-05T12:20:00' }); // Jordan was due at 12:00
    const [appt] = await scheduler.findUpcomingByPhone(JORDAN);
    const res = await scheduler.reportLate({ appointmentId: appt.id, phone: JORDAN, minutesLate: 10 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(hhmm(res.expectedArrival)).toBe('12:30');
      expect(res.minutesLate).toBe(30);
      expect(res.withinGrace).toBe(false);
    }
  });

  it('still measures from the appointment time when that is consistent', async () => {
    const { scheduler } = makeApp({ now: '2026-10-05T12:05:00' });
    const [appt] = await scheduler.findUpcomingByPhone(JORDAN);
    const res = await scheduler.reportLate({ appointmentId: appt.id, phone: JORDAN, minutesLate: 10 });
    expect(res.ok && res.withinGrace).toBe(true);
    expect(res.ok && res.minutesLate).toBe(10);
  });
});

describe('caller identity in the log', () => {
  it("does not carry one number's name over to a corrected number", async () => {
    const app = makeApp();
    await app.run('lookup_appointments', { phone: '415-555-0142' }); // Dana Kim
    await app.run('lookup_appointments', { phone: '415-555-0188' }); // nobody we know
    app.tracker.setTranscript('call-1', [{ role: 'caller', text: 'hi' }]);
    await app.tracker.end('call-1');
    const row = await app.contacts.getContact('+14155550188');
    expect(row!.name).toBe('');
    expect(app.contacts.callLog[0].name).toBe('');
  });

  it('counts each call once even when two calls from one number overlap', async () => {
    const app = makeApp();
    const base = { service: 'express_wash', customer_name: 'Sara', phone: '415-555-0190' };
    await app.run('book_appointment', { ...base, date: 'Tuesday', time: '09:00' }, { callId: 'A' });
    await app.run('book_appointment', { ...base, date: 'Wednesday', time: '09:00' }, { callId: 'B' });
    await app.run('book_appointment', { ...base, date: 'Friday', time: '14:00' }, { callId: 'A' });
    await app.tracker.end('A');
    await app.tracker.end('B');
    const row = (await app.contacts.getContact('+14155550190'))!;
    expect(row.totalCalls).toBe(2);
    expect(row.callHistory.split('\n')).toHaveLength(2);
    expect(row.callIds).toBe('B, A');
  });

  it('labels an ended call that has no summary', async () => {
    const app = makeApp();
    app.tracker.start('q', 'voice', '+14155550123');
    app.tracker.setTranscript('q', [{ role: 'caller', text: 'What are your hours?' }]);
    await app.tracker.end('q');
    expect(app.contacts.callLog[0].summary).toBe('No actions taken; summary unavailable.');
  });
});

describe('lenient arguments', () => {
  it('accepts null for optional fields and a number for the phone', async () => {
    const app = makeApp();
    const check = await app.run('check_availability', { service: 'express_wash', date: 'Tuesday', time: null });
    expect(check.open_start_times.length).toBeGreaterThan(0);
    const booked = await app.run('book_appointment', {
      service: 'express_wash',
      date: 'Tuesday',
      time: '09:00',
      customer_name: 'Sara',
      phone: 4155550190,
      vehicle: null,
      notes: '',
    });
    expect(booked).toMatchObject({ booked: true, customer: { phone: '(415) 555-0190' } });
  });
});

describe('phone numbers', () => {
  it('uses caller ID only for an explicit sentinel, never for a garbled number', async () => {
    const voice = { channel: 'voice' as const, callerId: '+14155550123' };
    const base = { service: 'express_wash', date: 'Tuesday', time: '09:00', customer_name: 'Sara' };
    const spelled = await makeApp().run('book_appointment', { ...base, phone: 'four one five five five five oh one nine nine' }, voice);
    expect(spelled).toMatchObject({ ok: false, error: 'invalid_phone' });
    for (const phone of ['caller_id', 'same number', 'this number', "the number I'm calling from"]) {
      const res = await makeApp().run('book_appointment', { ...base, phone }, voice);
      expect(res, phone).toMatchObject({ booked: true, customer: { phone: '(415) 555-0123' } });
    }
  });

  it('rejects a +1 number that is a digit short or long', () => {
    expect(normalizePhone('+1415555019')).toBeNull();
    expect(normalizePhone('+141555501901')).toBeNull();
    expect(normalizePhone('+14155550190')).toBe('+14155550190');
  });
});

describe('whole-day answers', () => {
  it('says why a day has no times: one-off closure, too far ahead, already gone', async () => {
    const app = makeApp();
    const closure = await app.run('check_availability', { service: 'express_wash', date: '2026-10-14' });
    expect(closure.open_start_times).toEqual([]);
    expect(closure.message).toBe('The shop is closed on Wednesday, October 14.');
    const far = await app.run('check_availability', { service: 'express_wash', date: '2027-02-01' });
    expect(far.message).toContain('60 days ahead');
    const past = await app.run('check_availability', { service: 'express_wash', date: '2026-10-01' });
    expect(past.message).toBe('That day has already passed.');
    const full = await app.run('check_availability', { service: 'express_wash', date: 'Saturday' });
    expect(full.message).toBe('There are no open times left that day.');
  });

  it('treats an all-day "Vacation" event as a closure even when marked free', async () => {
    const app = makeApp();
    await app.calendar.createEvent({
      start: at('2026-10-13', '00:00').toUTC().toISO()!,
      end: at('2026-10-14', '00:00').toUTC().toISO()!,
      allDay: true,
      busy: false,
      summary: 'Owner vacation',
      description: '',
      props: {},
    });
    expect(await app.scheduler.checkSlot(60, at('2026-10-13', '10:00'))).toMatchObject({ ok: false, problem: 'closed_day' });
  });
});

describe('naming today\'s weekday', () => {
  it('means next week once that time can no longer be booked today', async () => {
    const thursday4pm = makeApp({ now: '2026-10-08T16:00:00' });
    const res = await thursday4pm.run('check_availability', { service: 'interior_detail_wash', date: 'Thursday', time: '15:30' });
    expect(res.available ? res.slot.date : res.requested.date).toBe('2026-10-15');
    // "today" and "this Thursday" are explicit and stay on today.
    const explicit = await thursday4pm.run('check_availability', { service: 'interior_detail_wash', date: 'today', time: '15:30' });
    expect(explicit).toMatchObject({ available: false, reason: 'in_past' });
  });

  it('means today while the time is still ahead, and the seed data follows the same rule', async () => {
    for (const now of ['2026-10-08T09:00:00', '2026-10-08T11:00:00', '2026-10-08T14:45:00', '2026-10-08T15:10:00', '2026-10-08T16:00:00']) {
      const clock = fixedClock(now);
      const calendar = new MemoryCalendar(seedEvents(clock()));
      const app = createApp({ clock, calendar, contacts: new MemoryContacts(), llm: null });
      const res = (await app.tools.execute(
        'check_availability',
        { service: 'interior_detail_wash', date: 'Thursday', time: '15:30' },
        { callId: 'c', channel: 'chat' },
      )) as Record<string, any>;
      // Whatever Thursday the caller means at this moment, the demo data has 3:30 taken and 4:30 free on it.
      expect(res, now).toMatchObject({ available: false, reason: 'full' });
      expect(res.requested.date, now).toBe(isoDate(seedThursday(clock())));
      expect(res.nearest_open_times.same_day[0].time, now).toBe('16:30');
    }
  });
});

describe('HTTP edge cases', () => {
  it('answers 400 to a malformed JSON body', async () => {
    const server = createServer(makeApp()).listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"message": ' });
    expect(res.status).toBe(400);
    server.close();
  });
});

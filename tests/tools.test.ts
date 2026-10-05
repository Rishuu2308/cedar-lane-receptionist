import { describe, expect, it } from 'vitest';
import type { CalendarStore } from '../src/calendar/types.js';
import { createApp } from '../src/app.js';
import { MemoryContacts } from '../src/contacts/memory.js';
import { fixedClock } from '../src/time.js';
import { MONDAY_10AM, makeApp } from './helpers.js';

const SARA = '+14155550190';

describe('check_availability', () => {
  it('answers the question from the brief', async () => {
    const app = makeApp();
    const res = await app.run('check_availability', { service: 'interior_detail_wash', date: 'Thursday', time: '15:30' });
    expect(res).toMatchObject({ ok: true, available: false, reason: 'full' });
    expect(res.requested.spoken).toBe('Thursday, October 8 at 3:30 PM');
    expect(res.nearest_open_times.same_day[0]).toEqual({
      date: '2026-10-08',
      time: '16:30',
      spoken: 'Thursday, October 8 at 4:30 PM',
    });
  });

  it('confirms an open slot', async () => {
    const app = makeApp();
    const res = await app.run('check_availability', { service: 'interior_detail_wash', date: '2026-10-08', time: '4:30 PM' });
    expect(res).toMatchObject({ ok: true, available: true });
    expect(res.slot.time).toBe('16:30');
  });

  it('lists open times when no time is given', async () => {
    const app = makeApp();
    const res = await app.run('check_availability', { service: 'interior_detail_wash', date: 'thursday' });
    expect(res.day).toMatchObject({ date: '2026-10-08', spoken: 'Thursday, October 8', hours: '8:00 AM to 6:00 PM' });
    expect(res.open_start_times.map((t: any) => t.time)).toContain('16:30');
    expect(res.open_start_times.map((t: any) => t.time)).not.toContain('15:30');
  });

  it('explains a closed day and points to the next days with room', async () => {
    const app = makeApp();
    const res = await app.run('check_availability', { service: 'express_wash', date: 'Sunday' });
    expect(res.open_start_times).toEqual([]);
    expect(res.message).toContain('closed on Sundays');
    expect(res.next_days_with_openings[0].date).toBe('2026-10-12');
  });

  it('asks instead of guessing when the date is unclear', async () => {
    const app = makeApp();
    const ambiguous = await app.run('check_availability', { service: 'express_wash', date: 'next Thursday', time: '10:00' });
    expect(ambiguous).toMatchObject({ ok: false, error: 'date_ambiguous' });
    const garbage = await app.run('check_availability', { service: 'express_wash', date: 'whenever', time: '10:00' });
    expect(garbage).toMatchObject({ ok: false, error: 'date_unparseable' });
    const badTime = await app.run('check_availability', { service: 'express_wash', date: 'Friday', time: 'lunchtime' });
    expect(badTime).toMatchObject({ ok: false, error: 'time_unparseable' });
  });

  it('rejects a service that does not exist', async () => {
    const app = makeApp();
    const res = await app.run('check_availability', { service: 'ceramic_coating', date: 'Friday' });
    expect(res).toMatchObject({ ok: false, error: 'invalid_arguments' });
  });
});

describe('book_appointment', () => {
  const booking = {
    service: 'interior_detail_wash',
    date: 'Thursday',
    time: '16:30',
    customer_name: 'Sara',
    phone: '415-555-0190',
  };

  it('books, and writes the caller and the call to the sheet', async () => {
    const app = makeApp();
    const res = await app.run('book_appointment', booking);
    expect(res).toMatchObject({ ok: true, booked: true });
    expect(res.appointment).toMatchObject({ service: 'Interior Detail & Wash', date: '2026-10-08', time: '16:30', ends: '5:30 PM' });
    expect(res.customer).toEqual({ name: 'Sara', phone: '(415) 555-0190' });
    expect(app.calendar.all().filter((e) => e.props.phone === SARA)).toHaveLength(1);

    await app.tracker.flush();
    const contact = await app.contacts.getContact(SARA);
    expect(contact).toMatchObject({ name: 'Sara', totalCalls: 1, lastCallReason: 'booking' });
    expect(contact!.nextAppointment).toBe('Thu Oct 8, 4:30 PM - Interior Detail & Wash');
    expect(contact!.callHistory).toContain('Booked Interior Detail & Wash for Sara on Thursday, October 8 at 4:30 PM');
    expect(app.contacts.callLog).toHaveLength(1);
    expect(app.contacts.callLog[0]).toMatchObject({ callId: 'call-1', phone: SARA, name: 'Sara', reasons: 'booking', followUpNeeded: 'no' });
  });

  it('refuses a taken slot, creates nothing, logs nothing, and offers alternatives', async () => {
    const app = makeApp();
    const before = app.calendar.all().length;
    const res = await app.run('book_appointment', { ...booking, time: '15:30' });
    expect(res).toMatchObject({ ok: false, booked: false, error: 'full' });
    expect(res.message).toContain('Nothing was booked');
    expect(res.nearest_open_times.same_day[0].time).toBe('16:30');
    expect(app.calendar.all()).toHaveLength(before);
    await app.tracker.flush();
    expect(app.contacts.callLog).toHaveLength(0);
    expect(await app.contacts.getContact(SARA)).toBeNull();
  });

  it('refuses incomplete phone numbers and missing names', async () => {
    const app = makeApp();
    const before = app.calendar.all().length;
    expect(await app.run('book_appointment', { ...booking, phone: '555-0190' })).toMatchObject({ ok: false, booked: false, error: 'invalid_phone' });
    expect(await app.run('book_appointment', { ...booking, customer_name: 'unknown' })).toMatchObject({ ok: false, error: 'missing_name' });
    const { customer_name: _omit, ...noName } = booking;
    expect(await app.run('book_appointment', noName)).toMatchObject({ ok: false, error: 'invalid_arguments' });
    expect(app.calendar.all()).toHaveLength(before);
  });

  it('accepts arguments as a JSON string and rejects malformed JSON', async () => {
    const app = makeApp();
    expect(await app.run('book_appointment', JSON.stringify(booking))).toMatchObject({ booked: true });
    expect(await app.run('book_appointment', '{"service": ')).toMatchObject({ ok: false, error: 'invalid_arguments' });
  });

  it('does not double-book when the model repeats the call', async () => {
    const app = makeApp();
    await app.run('book_appointment', booking);
    const again = await app.run('book_appointment', booking);
    expect(again).toMatchObject({ ok: true, booked: true });
    expect(again.note).toContain('already on the calendar');
    expect(app.calendar.all().filter((e) => e.props.phone === SARA)).toHaveLength(1);
    await app.tracker.flush();
    expect((await app.contacts.getContact(SARA))!.totalCalls).toBe(1);
  });

  it('stores the vehicle and notes on the event', async () => {
    const app = makeApp();
    await app.run('book_appointment', { ...booking, vehicle: '2021 Honda CR-V', notes: 'Pet hair removal add-on' });
    const ev = app.calendar.all().find((e) => e.props.phone === SARA)!;
    expect(ev.description).toContain('Vehicle: 2021 Honda CR-V');
    expect(ev.description).toContain('Notes: Pet hair removal add-on');
    await app.tracker.flush();
    expect((await app.contacts.getContact(SARA))!.vehicle).toBe('2021 Honda CR-V');
  });

  it('on a voice call, "caller_id" books under the number the call came from', async () => {
    const app = makeApp();
    const res = await app.run('book_appointment', { ...booking, phone: 'caller_id' }, { channel: 'voice', callerId: '+14155550190' });
    expect(res).toMatchObject({ booked: true, customer: { phone: '(415) 555-0190' } });
    // ...but not on a chat, where there is no caller ID.
    const chat = await makeApp().run('book_appointment', { ...booking, phone: 'caller_id' });
    expect(chat).toMatchObject({ ok: false, error: 'invalid_phone' });
  });
});

describe('lookup, reschedule, cancel', () => {
  it('walks through a reschedule', async () => {
    const app = makeApp();
    const found = await app.run('lookup_appointments', { phone: '(415) 555-0142' });
    expect(found).toMatchObject({ ok: true, found: 1, customer_name: 'Dana Kim' });
    const id = found.appointments[0].appointment_id;

    const taken = await app.run('reschedule_appointment', { appointment_id: id, phone: '415 555 0142', new_date: 'Thursday', new_time: '15:30' });
    expect(taken).toMatchObject({ ok: false, rescheduled: false, error: 'full' });
    expect(taken.message).toContain('has not been changed');

    const moved = await app.run('reschedule_appointment', { appointment_id: id, phone: '415 555 0142', new_date: 'Thursday', new_time: '16:30' });
    expect(moved).toMatchObject({ ok: true, rescheduled: true });
    expect(moved.previous.spoken).toBe('Friday, October 9 at 10:00 AM');
    expect(moved.appointment.spoken).toBe('Thursday, October 8 at 4:30 PM');

    await app.tracker.flush();
    const contact = await app.contacts.getContact('+14155550142');
    expect(contact!.totalCalls).toBe(2); // one seeded call plus this one
    expect(contact!.lastCallReason).toBe('reschedule');
    expect(contact!.nextAppointment).toContain('Thu Oct 8, 4:30 PM');
    expect(contact!.callHistory.split('\n')).toHaveLength(2);
  });

  it('cancels only with the matching phone number', async () => {
    const app = makeApp();
    const found = await app.run('lookup_appointments', { phone: '4155550142' });
    const id = found.appointments[0].appointment_id;
    expect(await app.run('cancel_appointment', { appointment_id: id, phone: '415-555-0190' })).toMatchObject({ ok: false, cancelled: false });
    expect(await app.calendar.getEvent(id)).not.toBeNull();
    expect(await app.run('cancel_appointment', { appointment_id: id, phone: '415-555-0142' })).toMatchObject({ ok: true, cancelled: true });
    expect(await app.calendar.getEvent(id)).toBeNull();
    await app.tracker.flush();
    expect((await app.contacts.getContact('+14155550142'))!.nextAppointment).toBe('');
  });

  it('says so when there is nothing under a number', async () => {
    const app = makeApp();
    const res = await app.run('lookup_appointments', { phone: '415-555-0000' });
    expect(res).toMatchObject({ ok: true, found: 0 });
    expect(res.appointments).toBeUndefined();
  });
});

describe('report_running_late', () => {
  it('reports the outcome for each case', async () => {
    const app = makeApp();
    const found = await app.run('lookup_appointments', { phone: '415-555-0177' });
    const id = found.appointments[0].appointment_id;
    const ok = await app.run('report_running_late', { appointment_id: id, phone: '415-555-0177', minutes_late: 10 });
    expect(ok).toMatchObject({ ok: true, noted: true, outcome: 'held', expected_arrival: '12:10 PM' });
    const late = await app.run('report_running_late', { appointment_id: id, phone: '415-555-0177', minutes_late: '45' });
    expect(late).toMatchObject({ ok: true, outcome: 'needs_new_time' });
    expect(late.later_today.time).toBe('13:00');
    await app.tracker.flush();
    expect(app.contacts.callLog[0].reasons).toBe('running_late');
    expect(app.contacts.callLog[0].actions).toContain('within grace period');
  });

  it('rejects nonsense durations', async () => {
    const app = makeApp();
    const found = await app.run('lookup_appointments', { phone: '415-555-0177' });
    const id = found.appointments[0].appointment_id;
    expect(await app.run('report_running_late', { appointment_id: id, phone: '415-555-0177', minutes_late: -5 })).toMatchObject({
      ok: false,
      error: 'invalid_arguments',
    });
  });
});

describe('request_human_followup', () => {
  it('flags the caller for a callback in both tabs', async () => {
    const app = makeApp();
    const res = await app.run('request_human_followup', {
      category: 'billing_dispute',
      summary: 'Charged $160 for an Interior Detail & Wash on a sedan last Friday, expected $120. Wants the difference refunded.',
      customer_name: 'Tom Reyes',
      phone: '415-555-0133',
    });
    expect(res).toMatchObject({ ok: true, logged: true, callback_number: '(415) 555-0133' });
    expect(res.message).toContain('by the end of the next business day');
    await app.tracker.flush();
    const contact = await app.contacts.getContact('+14155550133');
    expect(contact!.needsFollowUp).toContain('billing_dispute');
    expect(contact!.needsFollowUp).toContain('Tom Reyes');
    expect(app.contacts.callLog[0]).toMatchObject({ reasons: 'billing_complaint', followUpNeeded: 'YES' });
  });

  it('needs a callback number', async () => {
    const app = makeApp();
    const res = await app.run('request_human_followup', {
      category: 'custom_quote',
      summary: 'Wants a ceramic coating quote for a 2023 BMW X5.',
      customer_name: 'Alice',
      phone: 'not given',
    });
    expect(res).toMatchObject({ ok: false, logged: false, error: 'invalid_phone' });
  });
});

describe('call logging', () => {
  it('keeps one row per call and one row per caller across calls', async () => {
    const app = makeApp();
    const booking = { service: 'express_wash', customer_name: 'Sara', phone: '415-555-0190' };
    await app.run('book_appointment', { ...booking, date: 'Tuesday', time: '09:00' }, { callId: 'call-A' });
    await app.run('book_appointment', { ...booking, date: 'Wednesday', time: '09:00' }, { callId: 'call-A' });
    await app.run('book_appointment', { ...booking, date: 'Friday', time: '14:00' }, { callId: 'call-B' });
    await app.tracker.flush();

    expect(app.contacts.callLog.map((r) => r.callId)).toEqual(['call-A', 'call-B']);
    expect(app.contacts.callLog[0].actions.split(' | ')).toHaveLength(2);
    const rows = app.contacts.contacts.filter((c) => c.phone === SARA);
    expect(rows).toHaveLength(1);
    expect(rows[0].totalCalls).toBe(2);
    expect(rows[0].callHistory.split('\n')).toHaveLength(2);
    expect(rows[0].nextAppointment).toContain('Tue Oct 6, 9:00 AM');
  });

  it('marks the call ended and adds the summary when the call finishes', async () => {
    const app = makeApp();
    app.tracker.start('call-Z', 'chat');
    app.tracker.setTranscript('call-Z', [
      { role: 'caller', text: 'What are your hours on Saturday?' },
      { role: 'agent', text: 'We are open 9 to 4 on Saturdays.' },
    ]);
    await app.tracker.end('call-Z');
    // No LLM in this test, so the row is written without a summary, but it is written.
    expect(app.contacts.callLog).toHaveLength(1);
    expect(app.contacts.callLog[0]).toMatchObject({ callId: 'call-Z', status: 'ended', phone: '' });
    expect(app.contacts.contacts.some((c) => c.callIds.includes('call-Z'))).toBe(false);
  });

  it('writes nothing for a call where nothing was said', async () => {
    const app = makeApp();
    app.tracker.start('call-empty', 'chat');
    await app.tracker.end('call-empty');
    expect(app.contacts.callLog).toHaveLength(0);
  });
});

describe('failure handling', () => {
  it('turns a calendar outage into a clear failure result and leaves a trace for staff', async () => {
    const broken = new Proxy({} as CalendarStore, {
      get: () => async () => {
        throw new Error('Google is down');
      },
    });
    const app = createApp({ clock: fixedClock(MONDAY_10AM), calendar: broken, contacts: new MemoryContacts(), llm: null });
    const res = await app.tools.execute(
      'book_appointment',
      { service: 'express_wash', date: 'Tuesday', time: '09:00', customer_name: 'Sara', phone: '415-555-0190' },
      { callId: 'c', channel: 'chat' },
    );
    expect(res).toMatchObject({ ok: false, error: 'system_error' });
    expect(res.message).toContain('Do not tell the caller anything was booked');
    await app.tracker.flush();
    const log = (app.contacts as MemoryContacts).callLog;
    expect(log).toHaveLength(1);
    expect(log[0].actions).toContain('System error during book_appointment');
    expect(log[0].followUpNeeded).toBe('YES');
  });

  it('rejects unknown tools', async () => {
    const app = makeApp();
    expect(await app.run('delete_everything', {})).toMatchObject({ ok: false, error: 'unknown_tool' });
  });
});

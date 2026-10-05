import { describe, expect, it } from 'vitest';
import { fitsCapacity } from '../src/scheduling.js';
import { getService } from '../src/shop.js';
import { hhmm, isoDate } from '../src/time.js';
import { at, makeApp } from './helpers.js';

// Seeded calendar, relative to Monday 2026-10-05 10:00 AM:
//   Mon Oct 5   Jordan Lee      Interior Detail & Wash  12:00-1:00 PM
//   Thu Oct 8   Priya Nair      Full Detail             1:00-3:30 PM
//               Marcus Webb     Interior Detail & Wash  3:30-4:30 PM
//   Fri Oct 9   Dana Kim        Exterior Detail         10:00-11:00 AM
//   Sat Oct 10  fully booked 9:00 AM-4:00 PM
//   Mon Oct 12  staff lunch 12:00-1:00 PM (hand-made event)
//   Wed Oct 14  closed all day

const interior = getService('interior_detail_wash')!;
const full = getService('full_detail')!;
const DANA = '+14155550142';
const JORDAN = '+14155550177';
const SARA = '+14155550190';

describe('availability', () => {
  it('reproduces the brief: Thursday 3:30 is full and 4:30 is the nearest opening', async () => {
    const { scheduler } = makeApp();
    const check = await scheduler.checkSlot(60, at('2026-10-08', '15:30'));
    expect(check).toMatchObject({ ok: false, problem: 'full' });
    const alt = await scheduler.alternatives(60, at('2026-10-08', '15:30'));
    expect(hhmm(alt.sameDay[0])).toBe('16:30');
    expect((await scheduler.checkSlot(60, at('2026-10-08', '16:30'))).ok).toBe(true);
  });

  it('treats any overlap as a conflict, not just an identical start time', async () => {
    const { scheduler } = makeApp();
    // 3:00-4:00 overlaps both the 1:00-3:30 and the 3:30-4:30 bookings.
    expect(await scheduler.checkSlot(60, at('2026-10-08', '15:00'))).toMatchObject({ ok: false, problem: 'full' });
    // 12:00-1:00 ends exactly when the 1:00 booking starts: allowed.
    expect((await scheduler.checkSlot(60, at('2026-10-08', '12:00'))).ok).toBe(true);
    // A 2.5 hour Full Detail at 11:00 would run into the 1:00 booking.
    expect(await scheduler.checkSlot(full.durationMinutes, at('2026-10-08', '11:00'))).toMatchObject({ ok: false, problem: 'full' });
  });

  it('enforces opening hours', async () => {
    const { scheduler } = makeApp();
    expect(await scheduler.checkSlot(60, at('2026-10-11', '10:00'))).toMatchObject({ ok: false, problem: 'closed_day' }); // Sunday
    expect(await scheduler.checkSlot(60, at('2026-10-06', '07:00'))).toMatchObject({ ok: false, problem: 'before_open' });
    expect(await scheduler.checkSlot(60, at('2026-10-06', '19:00'))).toMatchObject({ ok: false, problem: 'past_close' });
    // Saturday opens at 9, not 8.
    expect(await scheduler.checkSlot(60, at('2026-10-17', '08:00'))).toMatchObject({ ok: false, problem: 'before_open' });
  });

  it('requires the whole service to finish before closing', async () => {
    const { scheduler } = makeApp();
    expect((await scheduler.checkSlot(60, at('2026-10-06', '17:00'))).ok).toBe(true);
    const late = await scheduler.checkSlot(60, at('2026-10-06', '17:30'));
    expect(late).toMatchObject({ ok: false, problem: 'past_close' });
    if (!late.ok) expect(late.message).toContain('5:00 PM');
    expect(await scheduler.checkSlot(full.durationMinutes, at('2026-10-06', '16:00'))).toMatchObject({ ok: false, problem: 'past_close' });
    expect((await scheduler.checkSlot(full.durationMinutes, at('2026-10-06', '15:30'))).ok).toBe(true);
  });

  it('rejects past, too-soon, off-grid and far-future times', async () => {
    const { scheduler } = makeApp();
    expect(await scheduler.checkSlot(60, at('2026-10-05', '09:00'))).toMatchObject({ ok: false, problem: 'in_past' });
    expect(await scheduler.checkSlot(60, at('2026-10-02', '10:00'))).toMatchObject({ ok: false, problem: 'in_past' });
    expect(await scheduler.checkSlot(30, at('2026-10-05', '10:15'))).toMatchObject({ ok: false, problem: 'off_grid' });
    expect(await scheduler.checkSlot(30, at('2026-10-06', '10:45'))).toMatchObject({ ok: false, problem: 'off_grid' });
    expect((await scheduler.checkSlot(30, at('2026-10-05', '10:30'))).ok).toBe(true); // exactly the 30 minute lead
    expect(await scheduler.checkSlot(60, at('2027-03-01', '10:00'))).toMatchObject({ ok: false, problem: 'beyond_horizon' });

    const { scheduler: later } = makeApp({ now: '2026-10-05T10:10:00' });
    expect(await later.checkSlot(30, at('2026-10-05', '10:30'))).toMatchObject({ ok: false, problem: 'too_soon' });
  });

  it('reports no openings on a fully booked day and offers other days', async () => {
    const { scheduler } = makeApp();
    expect(await scheduler.openStarts(30, at('2026-10-10', '00:00'))).toHaveLength(0);
    const alt = await scheduler.alternatives(60, at('2026-10-10', '10:00'));
    expect(alt.sameDay).toHaveLength(0);
    // Sunday is closed, so the next options are on Monday.
    expect(alt.otherDays.length).toBeGreaterThan(0);
    expect(isoDate(alt.otherDays[0])).toBe('2026-10-12');
  });

  it('respects events that were typed in by hand and all-day closures', async () => {
    const { scheduler } = makeApp();
    expect(await scheduler.checkSlot(60, at('2026-10-12', '12:00'))).toMatchObject({ ok: false, problem: 'full' });
    expect(await scheduler.checkSlot(60, at('2026-10-12', '11:30'))).toMatchObject({ ok: false, problem: 'full' });
    expect((await scheduler.checkSlot(60, at('2026-10-12', '11:00'))).ok).toBe(true);
    expect(await scheduler.checkSlot(60, at('2026-10-14', '10:00'))).toMatchObject({ ok: false, problem: 'closed_day' });
    expect(await scheduler.openStarts(60, at('2026-10-14', '00:00'))).toHaveLength(0);
  });

  it('ignores events marked "free" and all-day notes that are not closures', async () => {
    const { scheduler, calendar } = makeApp();
    await calendar.createEvent({
      start: at('2026-10-06', '10:00').toUTC().toISO()!,
      end: at('2026-10-06', '11:00').toUTC().toISO()!,
      summary: 'Reminder: order supplies',
      description: '',
      busy: false,
      props: {},
    });
    await calendar.createEvent({
      start: at('2026-10-06', '00:00').toUTC().toISO()!,
      end: at('2026-10-07', '00:00').toUTC().toISO()!,
      allDay: true,
      busy: false,
      summary: "Dana's birthday",
      description: '',
      props: {},
    });
    expect((await scheduler.checkSlot(60, at('2026-10-06', '10:00'))).ok).toBe(true);
  });

  it('lists only bookable start times for a day', async () => {
    const { scheduler } = makeApp();
    const starts = (await scheduler.openStarts(60, at('2026-10-08', '00:00'))).map(hhmm);
    expect(starts).toEqual(['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '16:30', '17:00']);
    // Today: nothing before the lead time, nothing overlapping Jordan's 12:00-1:00.
    const today = (await scheduler.openStarts(60, at('2026-10-05', '00:00'))).map(hhmm);
    expect(today[0]).toBe('10:30');
    expect(today).toContain('11:00');
    expect(today).not.toContain('11:30');
    expect(today).not.toContain('12:00');
    expect(today).not.toContain('12:30');
    expect(today).toContain('13:00');
  });
});

describe('capacity with more than one bay', () => {
  const ev = (start: string, end: string) => ({
    start: at('2026-10-08', start).toUTC().toISO()!,
    end: at('2026-10-08', end).toUTC().toISO()!,
  });

  it('allows overlap up to the number of bays', () => {
    const one = [ev('15:30', '16:30')];
    expect(fitsCapacity(one, at('2026-10-08', '15:30'), at('2026-10-08', '16:30'), 1)).toBe(false);
    expect(fitsCapacity(one, at('2026-10-08', '15:30'), at('2026-10-08', '16:30'), 2)).toBe(true);
    const two = [ev('15:30', '16:30'), ev('16:00', '17:00')];
    expect(fitsCapacity(two, at('2026-10-08', '15:30'), at('2026-10-08', '16:30'), 2)).toBe(false);
  });

  it('counts peak concurrency, so back-to-back bookings share a bay', () => {
    const backToBack = [ev('15:00', '16:00'), ev('16:00', '17:00')];
    expect(fitsCapacity(backToBack, at('2026-10-08', '15:30'), at('2026-10-08', '16:30'), 2)).toBe(true);
  });
});

describe('booking', () => {
  it('books an open slot and blocks it for the next caller', async () => {
    const { scheduler, calendar } = makeApp();
    const before = calendar.all().length;
    const res = await scheduler.book({ service: interior, start: at('2026-10-08', '16:30'), name: 'Sara', phone: SARA });
    expect(res.ok).toBe(true);
    expect(calendar.all()).toHaveLength(before + 1);
    const ev = calendar.all().find((e) => e.props.phone === SARA)!;
    expect(ev.summary).toContain('Interior Detail & Wash');
    expect(ev.summary).toContain('Sara');
    expect(at('2026-10-08', '17:30').toMillis()).toBe(new Date(ev.end).getTime());

    const second = await scheduler.book({ service: interior, start: at('2026-10-08', '16:30'), name: 'Tom', phone: '+14155550199' });
    expect(second).toMatchObject({ ok: false, problem: 'full' });
    expect(calendar.all()).toHaveLength(before + 1);
  });

  it('never creates an event for an invalid slot', async () => {
    const { scheduler, calendar } = makeApp();
    const before = calendar.all().length;
    for (const [date, time] of [
      ['2026-10-08', '15:30'], // full
      ['2026-10-11', '10:00'], // Sunday
      ['2026-10-06', '17:30'], // runs past closing
      ['2026-10-01', '10:00'], // past
      ['2026-10-14', '10:00'], // closure
    ]) {
      const res = await scheduler.book({ service: interior, start: at(date, time), name: 'Sara', phone: SARA });
      expect(res.ok, `${date} ${time}`).toBe(false);
    }
    expect(calendar.all()).toHaveLength(before);
  });

  it('is idempotent when the same booking is requested twice', async () => {
    const { scheduler, calendar } = makeApp();
    const before = calendar.all().length;
    const first = await scheduler.book({ service: interior, start: at('2026-10-08', '16:30'), name: 'Sara', phone: SARA });
    const again = await scheduler.book({ service: interior, start: at('2026-10-08', '16:30'), name: 'Sara', phone: SARA });
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(calendar.all()).toHaveLength(before + 1);
  });

  it('lets exactly one of two simultaneous requests win the slot', async () => {
    const { scheduler, calendar } = makeApp();
    const before = calendar.all().length;
    const results = await Promise.all(
      ['+14155550201', '+14155550202', '+14155550203'].map((phone, i) =>
        scheduler.book({ service: interior, start: at('2026-10-06', '14:00'), name: `Caller ${i}`, phone }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(calendar.all()).toHaveLength(before + 1);
  });
});

describe('finding appointments', () => {
  it('finds upcoming appointments by phone number only', async () => {
    const { scheduler } = makeApp();
    const dana = await scheduler.findUpcomingByPhone(DANA);
    expect(dana).toHaveLength(1);
    expect(dana[0]).toMatchObject({ serviceId: 'exterior_detail', customerName: 'Dana Kim' });
    expect(await scheduler.findUpcomingByPhone('+14155559999')).toHaveLength(0);
  });

  it('recognises a hand-made event by the phone number in its title', async () => {
    const { scheduler, calendar } = makeApp();
    await calendar.createEvent({
      start: at('2026-10-07', '09:00').toUTC().toISO()!,
      end: at('2026-10-07', '11:30').toUTC().toISO()!,
      summary: 'Full detail - Omar 415.555.0166',
      description: '',
      props: {},
    });
    const found = await scheduler.findUpcomingByPhone('+14155550166');
    expect(found).toHaveLength(1);
    expect(found[0].serviceId).toBe('full_detail');
  });

  it('leaves out appointments that are already over', async () => {
    const { scheduler } = makeApp({ now: '2026-10-09T11:30:00' }); // Friday, after Dana's 10-11
    expect(await scheduler.findUpcomingByPhone(DANA)).toHaveLength(0);
  });
});

describe('rescheduling', () => {
  it('moves an appointment and frees the old slot', async () => {
    const { scheduler } = makeApp();
    const [appt] = await scheduler.findUpcomingByPhone(DANA);
    const res = await scheduler.reschedule({ appointmentId: appt.id, phone: DANA, newStart: at('2026-10-12', '14:00') });
    expect(res).toMatchObject({ ok: true, unchanged: false });
    const [moved] = await scheduler.findUpcomingByPhone(DANA);
    expect(moved.id).toBe(appt.id);
    expect(isoDate(moved.start)).toBe('2026-10-12');
    expect(hhmm(moved.start)).toBe('14:00');
    expect(hhmm(moved.end)).toBe('15:00');
    expect((await scheduler.checkSlot(60, at('2026-10-09', '10:00'))).ok).toBe(true);
  });

  it('leaves the appointment alone when the new time is taken', async () => {
    const { scheduler } = makeApp();
    const [appt] = await scheduler.findUpcomingByPhone(DANA);
    const res = await scheduler.reschedule({ appointmentId: appt.id, phone: DANA, newStart: at('2026-10-08', '15:30') });
    expect(res).toMatchObject({ ok: false, problem: 'full' });
    if (!res.ok) expect(hhmm(res.alternatives!.sameDay[0])).toBe('16:30');
    const [still] = await scheduler.findUpcomingByPhone(DANA);
    expect(isoDate(still.start)).toBe('2026-10-09');
    expect(hhmm(still.start)).toBe('10:00');
  });

  it('does not count the appointment as a conflict with itself', async () => {
    const { scheduler } = makeApp();
    const [appt] = await scheduler.findUpcomingByPhone(DANA);
    // 10:30-11:30 overlaps its own current 10:00-11:00 slot.
    const res = await scheduler.reschedule({ appointmentId: appt.id, phone: DANA, newStart: at('2026-10-09', '10:30') });
    expect(res.ok).toBe(true);
  });

  it("refuses to touch another caller's appointment", async () => {
    const { scheduler } = makeApp();
    const [appt] = await scheduler.findUpcomingByPhone(DANA);
    const res = await scheduler.reschedule({ appointmentId: appt.id, phone: SARA, newStart: at('2026-10-12', '14:00') });
    expect(res).toMatchObject({ ok: false, problem: 'not_found' });
    expect(await scheduler.cancel({ appointmentId: appt.id, phone: SARA })).toMatchObject({ ok: false, problem: 'not_found' });
    expect(await scheduler.findUpcomingByPhone(DANA)).toHaveLength(1);
  });

  it('handles an unknown appointment id', async () => {
    const { scheduler } = makeApp();
    const res = await scheduler.reschedule({ appointmentId: 'nope', phone: DANA, newStart: at('2026-10-12', '14:00') });
    expect(res).toMatchObject({ ok: false, problem: 'not_found' });
  });
});

describe('cancelling', () => {
  it('removes the event and frees the slot', async () => {
    const { scheduler, calendar } = makeApp();
    const [appt] = await scheduler.findUpcomingByPhone(DANA);
    expect(await scheduler.cancel({ appointmentId: appt.id, phone: DANA })).toMatchObject({ ok: true });
    expect(await calendar.getEvent(appt.id)).toBeNull();
    expect(await scheduler.findUpcomingByPhone(DANA)).toHaveLength(0);
    expect((await scheduler.checkSlot(60, at('2026-10-09', '10:00'))).ok).toBe(true);
  });
});

describe('running late', () => {
  it('holds the appointment within the grace period and leaves a note for staff', async () => {
    const { scheduler, calendar } = makeApp();
    const [appt] = await scheduler.findUpcomingByPhone(JORDAN);
    const res = await scheduler.reportLate({ appointmentId: appt.id, phone: JORDAN, minutesLate: 10 });
    expect(res).toMatchObject({ ok: true, withinGrace: true });
    expect((await calendar.getEvent(appt.id))!.description).toContain('LATE NOTICE');
    const [same] = await scheduler.findUpcomingByPhone(JORDAN);
    expect(hhmm(same.start)).toBe('12:00');
  });

  it('beyond the grace period, offers a later slot today that fits the whole service', async () => {
    const { scheduler } = makeApp();
    const [appt] = await scheduler.findUpcomingByPhone(JORDAN);
    const res = await scheduler.reportLate({ appointmentId: appt.id, phone: JORDAN, minutesLate: 40 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.withinGrace).toBe(false);
      expect(hhmm(res.expectedArrival)).toBe('12:40');
      expect(hhmm(res.laterToday!)).toBe('13:00');
    }
  });

  it('lets a late caller move to that slot even at short notice, after the original start time', async () => {
    const { scheduler } = makeApp({ now: '2026-10-05T12:05:00' });
    const [appt] = await scheduler.findUpcomingByPhone(JORDAN);
    const late = await scheduler.reportLate({ appointmentId: appt.id, phone: JORDAN, minutesLate: 25 });
    expect(late.ok && hhmm(late.laterToday!)).toBe('12:30');
    const moved = await scheduler.reschedule({ appointmentId: appt.id, phone: JORDAN, newStart: at('2026-10-05', '12:30') });
    expect(moved).toMatchObject({ ok: true, unchanged: false });
  });

  it('offers other days when nothing later today fits', async () => {
    const { scheduler, calendar } = makeApp();
    // Fill the rest of today after Jordan's appointment.
    await calendar.createEvent({
      start: at('2026-10-05', '13:00').toUTC().toISO()!,
      end: at('2026-10-05', '18:00').toUTC().toISO()!,
      summary: 'Fleet job',
      description: '',
      props: {},
    });
    const [appt] = await scheduler.findUpcomingByPhone(JORDAN);
    const res = await scheduler.reportLate({ appointmentId: appt.id, phone: JORDAN, minutesLate: 45 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.laterToday).toBeUndefined();
      expect(res.otherDays.length).toBeGreaterThan(0);
    }
  });

  it('only applies to appointments today', async () => {
    const { scheduler } = makeApp();
    const [appt] = await scheduler.findUpcomingByPhone(DANA);
    const res = await scheduler.reportLate({ appointmentId: appt.id, phone: DANA, minutesLate: 20 });
    expect(res).toMatchObject({ ok: false, problem: 'not_today' });
  });
});

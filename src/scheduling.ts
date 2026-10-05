/**
 * The scheduling rules. Everything the agent can do to the calendar goes through
 * this class, and every rule is enforced here in code rather than in the prompt:
 * opening hours, the slot grid, lead time, capacity, ownership of appointments.
 * The model can ask for anything; only valid changes reach the calendar.
 */
import { DateTime } from 'luxon';
import type { CalEvent, CalendarStore } from './calendar/types.js';
import { SHOP, getService, inferService, type Service, type ServiceId } from './shop.js';
import { type Clock, fmtDay, fmtTime, hoursFor, phoneKey, prettyPhone } from './time.js';

export type SlotProblem =
  | 'in_past'
  | 'too_soon'
  | 'beyond_horizon'
  | 'closed_day'
  | 'before_open'
  | 'past_close'
  | 'off_grid'
  | 'full';

export type SlotCheck = { ok: true } | { ok: false; problem: SlotProblem; message: string };

export interface Appointment {
  id: string;
  start: DateTime;
  end: DateTime;
  serviceId?: ServiceId;
  serviceName: string;
  customerName?: string;
  phone?: string;
  vehicle?: string;
}

export interface Alternatives {
  /** Open start times on the requested day, closest to the requested time first. */
  sameDay: DateTime[];
  /** Open start times on the following days (filled when the day itself has few options). */
  otherDays: DateTime[];
}

export interface ReadOptions {
  fresh?: boolean;
  ignoreEventId?: string;
  /** Skip the minimum lead time. Used when pushing a late customer's appointment later the same day. */
  allowShortLead?: boolean;
}

/**
 * All-day events created in the Google Calendar UI default to "Free", so a closure is
 * also recognised by its title.
 */
const CLOSURE_TITLE = /\b(closed|closure|holiday|vacation|shut)\b/i;

/** Marks events the agent created, so staff and tools can tell them apart. */
export const AGENT_PROP = 'cedarLane';

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * True when [start, end) can take one more vehicle given the events already there:
 * the peak number of simultaneous events inside the window must be below the bay count.
 */
export function fitsCapacity(events: Pick<CalEvent, 'start' | 'end'>[], start: DateTime, end: DateTime, bays: number): boolean {
  const s = start.toMillis();
  const e = end.toMillis();
  const overlapping = events
    .map((ev) => ({ s: new Date(ev.start).getTime(), e: new Date(ev.end).getTime() }))
    .filter((ev) => ev.e > s && ev.s < e);
  if (overlapping.length < bays) return true;
  const points = overlapping
    .flatMap((ev) => [
      { t: Math.max(ev.s, s), d: 1 },
      { t: Math.min(ev.e, e), d: -1 },
    ])
    // At the same instant, process departures before arrivals: back-to-back events do not overlap.
    .sort((a, b) => a.t - b.t || a.d - b.d);
  let current = 0;
  let peak = 0;
  for (const p of points) {
    current += p.d;
    peak = Math.max(peak, current);
  }
  return peak < bays;
}

export class Scheduler {
  /** Serialises check-then-write sequences so two callers cannot take the same slot. */
  private mutex = new Mutex();

  constructor(
    private cal: CalendarStore,
    private clock: Clock,
  ) {}

  now(): DateTime {
    return this.clock();
  }

  // ---------- reading ----------

  private async blockingEvents(day: DateTime, opts: ReadOptions): Promise<{ closed: boolean; events: CalEvent[] }> {
    const from = day.startOf('day');
    const to = from.plus({ days: 1 });
    const all = await this.cal.listEvents(from.toUTC().toISO()!, to.toUTC().toISO()!, { fresh: opts.fresh });
    const relevant = all.filter((e) => e.id !== opts.ignoreEventId);
    // An all-day event closes the shop when it is marked busy or is plainly a closure.
    const closed = relevant.some((e) => e.allDay && (e.busy || CLOSURE_TITLE.test(e.summary)));
    return { closed, events: relevant.filter((e) => !e.allDay && e.busy) };
  }

  /** Rules that do not depend on other bookings. */
  private staticCheck(durationMinutes: number, start: DateTime, allowShortLead = false): SlotCheck {
    const now = this.clock();
    const hours = hoursFor(start);
    if (start <= now) {
      return { ok: false, problem: 'in_past', message: `${fmtDay(start, now)} at ${fmtTime(start)} has already passed.` };
    }
    if (start > now.plus({ days: SHOP.bookingHorizonDays })) {
      return {
        ok: false,
        problem: 'beyond_horizon',
        message: `We only book up to ${SHOP.bookingHorizonDays} days ahead.`,
      };
    }
    if (!hours) {
      return { ok: false, problem: 'closed_day', message: `We are closed on ${start.toFormat('cccc')}s.` };
    }
    if (start < hours.open) {
      return {
        ok: false,
        problem: 'before_open',
        message: `We open at ${fmtTime(hours.open)} on ${start.toFormat('cccc')}s.`,
      };
    }
    const end = start.plus({ minutes: durationMinutes });
    if (end > hours.close) {
      const lastStart = hours.close.minus({ minutes: durationMinutes });
      return {
        ok: false,
        problem: 'past_close',
        message:
          `We close at ${fmtTime(hours.close)} on ${start.toFormat('cccc')}s and this service takes ${durationLabel(durationMinutes)}, ` +
          `so the latest start is ${fmtTime(lastStart)}.`,
      };
    }
    if (start.second !== 0 || start.minute % SHOP.slotMinutes !== 0) {
      return {
        ok: false,
        problem: 'off_grid',
        message: 'Appointments start on the hour or the half hour.',
      };
    }
    if (!allowShortLead && start < now.plus({ minutes: SHOP.minLeadMinutes })) {
      return {
        ok: false,
        problem: 'too_soon',
        message: `That is less than ${SHOP.minLeadMinutes} minutes from now, which is too soon to book.`,
      };
    }
    return { ok: true };
  }

  async checkSlot(durationMinutes: number, start: DateTime, opts: ReadOptions = {}): Promise<SlotCheck> {
    const basic = this.staticCheck(durationMinutes, start, opts.allowShortLead);
    if (!basic.ok) return basic;
    const { closed, events } = await this.blockingEvents(start, opts);
    if (closed) {
      return { ok: false, problem: 'closed_day', message: `The shop is closed on ${fmtDay(start, this.clock())}.` };
    }
    if (!fitsCapacity(events, start, start.plus({ minutes: durationMinutes }), SHOP.bays)) {
      return { ok: false, problem: 'full', message: `${fmtDay(start, this.clock())} at ${fmtTime(start)} is already booked.` };
    }
    return { ok: true };
  }

  /** Why a whole day cannot be booked, or null if it can (it may still be full). */
  async dayProblem(day: DateTime, opts: ReadOptions = {}): Promise<string | null> {
    const now = this.clock();
    if (day.startOf('day') < now.startOf('day')) return 'That day has already passed.';
    if (day.startOf('day') > now.plus({ days: SHOP.bookingHorizonDays })) {
      return `We only book up to ${SHOP.bookingHorizonDays} days ahead.`;
    }
    if (!hoursFor(day)) return `We are closed on ${day.toFormat('cccc')}s.`;
    if ((await this.blockingEvents(day, opts)).closed) return `The shop is closed on ${fmtDay(day, now)}.`;
    return null;
  }

  /** Every bookable start time on a day for a service of the given length. */
  async openStarts(durationMinutes: number, day: DateTime, opts: ReadOptions = {}): Promise<DateTime[]> {
    const hours = hoursFor(day);
    if (!hours) return [];
    const now = this.clock();
    if (day.startOf('day') < now.startOf('day')) return [];
    if (day.startOf('day') > now.plus({ days: SHOP.bookingHorizonDays })) return [];
    const { closed, events } = await this.blockingEvents(day, opts);
    if (closed) return [];
    const out: DateTime[] = [];
    for (let t = hours.open; t.plus({ minutes: durationMinutes }) <= hours.close; t = t.plus({ minutes: SHOP.slotMinutes })) {
      if (!this.staticCheck(durationMinutes, t, opts.allowShortLead).ok) continue;
      if (fitsCapacity(events, t, t.plus({ minutes: durationMinutes }), SHOP.bays)) out.push(t);
    }
    return out;
  }

  /** Nearby options when the requested slot cannot be used. */
  async alternatives(
    durationMinutes: number,
    requested: DateTime,
    opts: ReadOptions & { alwaysOtherDays?: boolean } = {},
  ): Promise<Alternatives> {
    const now = this.clock();
    // A day that has already gone is treated as "today at that time".
    const anchor =
      requested.startOf('day') < now.startOf('day')
        ? now.startOf('day').set({ hour: requested.hour, minute: requested.minute })
        : requested;
    const target = anchor.hour * 60 + anchor.minute;
    const closeness = (t: DateTime) => Math.abs(t.hour * 60 + t.minute - target);
    // Closest to the requested time first; on a tie prefer the later slot.
    const byCloseness = (a: DateTime, b: DateTime) => closeness(a) - closeness(b) || b.toMillis() - a.toMillis();

    const sameDay = (await this.openStarts(durationMinutes, anchor, opts))
      .filter((t) => !t.equals(requested))
      .sort(byCloseness)
      .slice(0, 3);

    const otherDays: DateTime[] = [];
    if (sameDay.length < 3 || opts.alwaysOtherDays) {
      for (let i = 1; i <= 14 && otherDays.length < 3; i++) {
        const day = anchor.startOf('day').plus({ days: i });
        const starts = (await this.openStarts(durationMinutes, day, opts)).sort(byCloseness).slice(0, 2);
        otherDays.push(...starts.sort((a, b) => a.toMillis() - b.toMillis()));
      }
    }
    return { sameDay, otherDays: otherDays.slice(0, 3) };
  }

  /** The next few days that have any opening, with their first open times. */
  async nextOpenDays(durationMinutes: number, after: DateTime, opts: ReadOptions = {}): Promise<{ day: DateTime; starts: DateTime[] }[]> {
    const out: { day: DateTime; starts: DateTime[] }[] = [];
    const now = this.clock();
    const base = after < now ? now : after;
    for (let i = 1; i <= 14 && out.length < 3; i++) {
      const day = base.startOf('day').plus({ days: i });
      const starts = await this.openStarts(durationMinutes, day, opts);
      if (starts.length) out.push({ day, starts });
    }
    return out;
  }

  toAppointment(ev: CalEvent): Appointment {
    const service = (ev.props.service && getService(ev.props.service)) || inferService(ev.summary);
    return {
      id: ev.id,
      start: DateTime.fromISO(ev.start, { setZone: true }).setZone(SHOP.timezone),
      end: DateTime.fromISO(ev.end, { setZone: true }).setZone(SHOP.timezone),
      serviceId: service?.id,
      serviceName: service?.name ?? (ev.summary || 'Appointment'),
      customerName: ev.props.name || undefined,
      phone: ev.props.phone || undefined,
      vehicle: ev.props.vehicle || undefined,
    };
  }

  /** Does this event belong to the caller with this phone number? */
  private static belongsTo(ev: CalEvent, phone: string): boolean {
    const key = phoneKey(phone);
    if (key.length < 10) return false;
    if (ev.props.phone) return phoneKey(ev.props.phone) === key;
    // Events typed in by hand have no properties; fall back to a number in the title or notes.
    return `${ev.summary} ${ev.description}`.replace(/\D/g, '').includes(key);
  }

  /** Appointments for this phone number that have not finished yet, soonest first. */
  async findUpcomingByPhone(phone: string, opts: ReadOptions = {}): Promise<Appointment[]> {
    const now = this.clock();
    const from = now.minus({ hours: 4 }).toUTC().toISO()!;
    const [tagged, window] = await Promise.all([
      this.cal.findByProp('phone', phone, from),
      this.cal.listEvents(from, now.plus({ days: 30 }).toUTC().toISO()!, { fresh: opts.fresh }),
    ]);
    const byId = new Map<string, CalEvent>();
    for (const ev of [...tagged, ...window]) {
      if (ev.allDay || !Scheduler.belongsTo(ev, phone)) continue;
      byId.set(ev.id, ev);
    }
    return [...byId.values()]
      .map((ev) => this.toAppointment(ev))
      .filter((a) => a.end > now)
      .sort((a, b) => a.start.toMillis() - b.start.toMillis());
  }

  private async ownedAppointment(id: string, phone: string): Promise<{ ev: CalEvent; appt: Appointment } | null> {
    const ev = await this.cal.getEvent(id);
    if (!ev || ev.allDay || !Scheduler.belongsTo(ev, phone)) return null;
    return { ev, appt: this.toAppointment(ev) };
  }

  // ---------- writing ----------

  async book(input: {
    service: Service;
    start: DateTime;
    name: string;
    phone: string;
    vehicle?: string;
    notes?: string;
    callId?: string;
    channel?: string;
  }): Promise<
    | { ok: true; appointment: Appointment; duplicate: boolean }
    | { ok: false; problem: SlotProblem; message: string; alternatives: Alternatives }
  > {
    return this.mutex.run(async () => {
      const { service, start } = input;
      const end = start.plus({ minutes: service.durationMinutes });

      // Asking twice for the same booking returns the existing one instead of a second event.
      // (The slot check does the one fresh calendar read; the lookup then reuses it.)
      const check = await this.checkSlot(service.durationMinutes, start, { fresh: true });
      const mine = await this.findUpcomingByPhone(input.phone);
      const existing = mine.find((a) => a.start.equals(start) && a.serviceId === service.id);
      if (existing) return { ok: true as const, appointment: existing, duplicate: true };

      if (!check.ok) {
        return {
          ok: false as const,
          problem: check.problem,
          message: check.message,
          alternatives: await this.alternatives(service.durationMinutes, start),
        };
      }

      const now = this.clock();
      const ev = await this.cal.createEvent({
        start: start.toUTC().toISO()!,
        end: end.toUTC().toISO()!,
        summary: `${service.name} - ${input.name} (${prettyPhone(input.phone)})`,
        description: [
          `Service: ${service.name} (${durationLabel(service.durationMinutes)})`,
          `Customer: ${input.name}`,
          `Phone: ${prettyPhone(input.phone)}`,
          input.vehicle ? `Vehicle: ${input.vehicle}` : null,
          input.notes ? `Notes: ${input.notes}` : null,
          `Booked by the AI receptionist (${input.channel ?? 'chat'}) on ${now.toFormat('LLL d, h:mm a')}.`,
        ]
          .filter(Boolean)
          .join('\n'),
        props: {
          [AGENT_PROP]: '1',
          service: service.id,
          name: input.name,
          phone: input.phone,
          ...(input.vehicle ? { vehicle: input.vehicle } : {}),
          ...(input.callId ? { callId: input.callId } : {}),
        },
      });

      // Guard against a writer outside this process (staff, another instance) taking
      // the slot between our check and our insert: re-read and back out if over capacity.
      // If this second read itself fails, the booking stands: the check above passed under the lock.
      const events = await this.blockingEvents(start, { fresh: true, ignoreEventId: ev.id }).then(
        (r) => r.events,
        (err) => {
          console.error('[scheduler] could not re-verify after booking; keeping the booking:', err);
          return [] as CalEvent[];
        },
      );
      if (!fitsCapacity(events, start, end, SHOP.bays)) {
        await this.cal.deleteEvent(ev.id);
        return {
          ok: false as const,
          problem: 'full' as const,
          message: `${fmtDay(start, now)} at ${fmtTime(start)} was just taken by someone else.`,
          alternatives: await this.alternatives(service.durationMinutes, start),
        };
      }
      return { ok: true as const, appointment: this.toAppointment(ev), duplicate: false };
    });
  }

  async reschedule(input: { appointmentId: string; phone: string; newStart: DateTime }): Promise<
    | { ok: true; appointment: Appointment; previousStart: DateTime; unchanged: boolean }
    | { ok: false; problem: SlotProblem | 'not_found' | 'already_over'; message: string; alternatives?: Alternatives }
  > {
    return this.mutex.run(async () => {
      const owned = await this.ownedAppointment(input.appointmentId, input.phone);
      if (!owned) return notFound();
      const { ev, appt } = owned;
      const now = this.clock();
      if (appt.end <= now) {
        return {
          ok: false as const,
          problem: 'already_over' as const,
          message: 'That appointment is already over, so it cannot be moved. Offer to book a new one.',
        };
      }
      if (appt.start.equals(input.newStart)) {
        return { ok: true as const, appointment: appt, previousStart: appt.start, unchanged: true };
      }
      const minutes = Math.round(appt.end.diff(appt.start, 'minutes').minutes);
      // A late customer may be pushed to a slot later the same day at short notice.
      const allowShortLead = input.newStart.hasSame(appt.start, 'day') && input.newStart > appt.start;
      const check = await this.checkSlot(minutes, input.newStart, { fresh: true, ignoreEventId: ev.id, allowShortLead });
      if (!check.ok) {
        return {
          ok: false as const,
          problem: check.problem,
          message: check.message,
          alternatives: await this.alternatives(minutes, input.newStart, { ignoreEventId: ev.id }),
        };
      }
      const newEnd = input.newStart.plus({ minutes });
      const note = `Moved from ${appt.start.toFormat('ccc LLL d, h:mm a')} by the AI receptionist on ${now.toFormat('LLL d, h:mm a')}.`;
      const updated = await this.cal.updateEvent(ev.id, {
        start: input.newStart.toUTC().toISO()!,
        end: newEnd.toUTC().toISO()!,
        description: [ev.description, note].filter(Boolean).join('\n'),
      });
      const events = await this.blockingEvents(input.newStart, { fresh: true, ignoreEventId: ev.id }).then(
        (r) => r.events,
        (err) => {
          console.error('[scheduler] could not re-verify after rescheduling; keeping the change:', err);
          return [] as CalEvent[];
        },
      );
      if (!fitsCapacity(events, input.newStart, newEnd, SHOP.bays)) {
        // Someone else took the new slot in the meantime: put the appointment back.
        await this.cal.updateEvent(ev.id, { start: ev.start, end: ev.end, description: ev.description });
        return {
          ok: false as const,
          problem: 'full' as const,
          message: `${fmtDay(input.newStart, now)} at ${fmtTime(input.newStart)} was just taken. The appointment is unchanged.`,
          alternatives: await this.alternatives(minutes, input.newStart, { ignoreEventId: ev.id }),
        };
      }
      return { ok: true as const, appointment: this.toAppointment(updated), previousStart: appt.start, unchanged: false };
    });
  }

  async cancel(input: { appointmentId: string; phone: string }): Promise<
    { ok: true; appointment: Appointment } | { ok: false; problem: 'not_found' | 'already_over'; message: string }
  > {
    return this.mutex.run(async () => {
      const owned = await this.ownedAppointment(input.appointmentId, input.phone);
      if (!owned) return notFound();
      if (owned.appt.end <= this.clock()) {
        return {
          ok: false as const,
          problem: 'already_over' as const,
          message: 'That appointment is already over, so there is nothing to cancel.',
        };
      }
      await this.cal.deleteEvent(owned.ev.id);
      return { ok: true as const, appointment: owned.appt };
    });
  }

  /**
   * Record that a customer is running late and work out what that means.
   * Within the grace period the slot is simply held. Beyond it, the appointment
   * is only still doable if a full-length slot starting at or after their arrival
   * is free, so we look for one and let the caller decide.
   */
  async reportLate(input: { appointmentId: string; phone: string; minutesLate: number }): Promise<
    | {
        ok: true;
        appointment: Appointment;
        withinGrace: boolean;
        expectedArrival: DateTime;
        /** Minutes after the scheduled start that they will actually arrive. */
        minutesLate: number;
        /** Beyond grace: a start time later today that still fits the whole service, if any. */
        laterToday?: DateTime;
        otherDays: DateTime[];
      }
    | { ok: false; problem: 'not_found' | 'not_today' | 'already_over'; message: string }
  > {
    return this.mutex.run(async () => {
      const owned = await this.ownedAppointment(input.appointmentId, input.phone);
      if (!owned) return notFound();
      const { ev, appt } = owned;
      const now = this.clock();
      if (appt.end <= now) {
        return { ok: false as const, problem: 'already_over' as const, message: 'That appointment time has already ended. Offer to book a new one.' };
      }
      if (!appt.start.hasSame(now, 'day')) {
        return {
          ok: false as const,
          problem: 'not_today' as const,
          message: `That appointment is on ${fmtDay(appt.start, now)} at ${fmtTime(appt.start)}, not today. If they cannot make it, offer to reschedule.`,
        };
      }
      // "Ten minutes" from someone whose start time has already gone by more than that
      // can only mean ten minutes from now, so measure from the clock in that case.
      let expectedArrival = appt.start.plus({ minutes: input.minutesLate });
      if (expectedArrival <= now) expectedArrival = now.plus({ minutes: input.minutesLate });
      const minutesLate = Math.ceil(expectedArrival.diff(appt.start, 'minutes').minutes);
      const note = `LATE NOTICE ${now.toFormat('h:mm a')}: customer expects to arrive about ${minutesLate} min late (around ${fmtTime(expectedArrival)}).`;
      await this.cal.updateEvent(ev.id, { description: [ev.description, note].filter(Boolean).join('\n') });

      if (minutesLate <= SHOP.lateGraceMinutes) {
        return { ok: true as const, appointment: appt, withinGrace: true, expectedArrival, minutesLate, otherDays: [] };
      }
      const minutes = Math.round(appt.end.diff(appt.start, 'minutes').minutes);
      const starts = await this.openStarts(minutes, appt.start, { fresh: true, ignoreEventId: ev.id, allowShortLead: true });
      const laterToday = starts.find((t) => t >= expectedArrival && t > appt.start);
      const otherDays = laterToday
        ? []
        : (await this.alternatives(minutes, appt.start, { ignoreEventId: ev.id, alwaysOtherDays: true })).otherDays;
      return { ok: true as const, appointment: appt, withinGrace: false, expectedArrival, minutesLate, laterToday, otherDays };
    });
  }
}

function notFound() {
  return {
    ok: false as const,
    problem: 'not_found' as const,
    message:
      'No appointment with that ID exists under that phone number. Call lookup_appointments with the phone number the caller booked under.',
  };
}

export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return h === 1 ? '1 hour' : `${h} hours`;
  return `${m} minutes`;
}

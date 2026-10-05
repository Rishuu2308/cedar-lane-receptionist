/**
 * The tools the model can call, shared by the text agent and the Vapi voice agent.
 *
 * Every argument is validated here and every business rule is enforced by the
 * Scheduler, so the worst a confused model can do is receive an error message
 * telling it what to ask the caller next. Results are small JSON objects that
 * always include a ready-to-say `spoken` form of any date or time.
 */
import type { DateTime } from 'luxon';
import { z } from 'zod';
import type { CallTracker, Reason } from './calls.js';
import type { ContactsStore } from './contacts/types.js';
import type { ToolSpec } from './llm.js';
import { type Alternatives, type Appointment, type Scheduler, durationLabel } from './scheduling.js';
import { SERVICE_IDS, SHOP, getService } from './shop.js';
import {
  type Clock,
  fmtDay,
  fmtDayTime,
  fmtTime,
  hhmm,
  hoursLabel,
  isOpenNow,
  isoDate,
  normalizePhone,
  parseTime,
  prettyPhone,
  resolveDate,
} from './time.js';

export interface ToolContext {
  callId: string;
  channel: 'chat' | 'voice';
  /** Voice only: the number the call came from. */
  callerId?: string;
}

export type ToolResult = Record<string, unknown> & { ok: boolean };

export interface ToolDeps {
  scheduler: Scheduler;
  tracker: CallTracker;
  contacts: ContactsStore;
  clock: Clock;
  /** True when a live transfer to a person is configured (voice). */
  canTransfer?: boolean;
}

interface ToolDef {
  spec: ToolSpec;
  /** Voice: one of these is spoken while the tool runs, so there is no dead air. */
  fillers: string[];
  /** True if the tool can change the calendar. A crash in one of these is flagged for staff. */
  mutates?: boolean;
  schema: z.ZodType;
  run(args: any, ctx: ToolContext): Promise<ToolResult>;
}

const DATE_DESC =
  'The day, either exactly as the caller said it ("Thursday", "tomorrow", "October 8") or as YYYY-MM-DD. ' +
  'The system works out the date; do not calculate dates yourself. Once a tool result has given you a YYYY-MM-DD date, reuse it.';
const TIME_DESC = 'Start time in the shop\'s local time, 24-hour HH:MM, for example "15:30" for 3:30 PM.';
const PHONE_DESC = 'The caller\'s phone number, digits as they gave them, for example "415-555-0190".';
const SERVICE_DESC = `Which service. One of: ${SERVICE_IDS.join(', ')}.`;

/** Optional text: models sometimes send null or "" for a field they are leaving out. */
const optionalText = z
  .string()
  .trim()
  .nullish()
  .transform((v) => v || undefined);
/** Phone numbers sometimes arrive as a JSON number. */
const phoneText = z.union([z.string().min(1), z.number()]).transform((v) => String(v));
/** Ways the model may say "the number this call is coming from". */
const CALLER_ID_SENTINEL = /^(caller[_ -]?id|same( number)?|this (number|one)|the number (i'?m|i am|they'?re|they are) calling from)$/i;

const FOLLOWUP_CATEGORIES = [
  'billing_dispute',
  'damage_or_quality_complaint',
  'custom_quote',
  'vehicle_needs_manager_approval',
  'caller_asked_for_a_person',
  'other',
] as const;

export class Tools {
  private defs: ToolDef[];

  constructor(private deps: ToolDeps) {
    this.defs = this.build();
  }

  specs(): ToolSpec[] {
    return this.defs.map((d) => d.spec);
  }

  fillersFor(name: string): string[] {
    return this.defs.find((d) => d.spec.name === name)?.fillers ?? [];
  }

  /** Run one tool call. Never throws: failures come back as { ok: false, ... }. */
  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const def = this.defs.find((d) => d.spec.name === name);
    if (!def) return { ok: false, error: 'unknown_tool', message: `There is no tool called ${name}.` };

    let args: unknown = rawArgs;
    if (typeof rawArgs === 'string') {
      try {
        args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      } catch {
        return { ok: false, error: 'invalid_arguments', message: 'The arguments were not valid JSON. Try the call again.' };
      }
    }
    const parsed = def.schema.safeParse(args ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ');
      return {
        ok: false,
        error: 'invalid_arguments',
        message: `Missing or invalid information (${issues}). Ask the caller for what is missing, then call the tool again.`,
      };
    }
    this.deps.tracker.start(ctx.callId, ctx.channel, ctx.callerId);
    try {
      return await def.run(parsed.data, ctx);
    } catch (err) {
      console.error(`[tools] ${name} failed:`, err);
      // Leave a trace for staff: if this happened mid-change, someone should look at the calendar.
      this.deps.tracker.record(
        ctx.callId,
        'other',
        `System error during ${name}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
        def.mutates ? `System error during ${name}. Check the calendar and contact the caller if needed.` : undefined,
      );
      return {
        ok: false,
        error: 'system_error',
        message:
          'The scheduling system had an error and this may not have gone through. Do not tell the caller anything was booked or changed. ' +
          'Apologise, and offer to try again or to have the team call them back (request_human_followup).',
      };
    }
  }

  // ---------- helpers ----------

  private slot(dt: DateTime) {
    return { date: isoDate(dt), time: hhmm(dt), spoken: fmtDayTime(dt, this.deps.clock()) };
  }

  private alternatives(alt: Alternatives) {
    return {
      same_day: alt.sameDay.map((t) => this.slot(t)),
      other_days: alt.otherDays.map((t) => this.slot(t)),
    };
  }

  private appointment(a: Appointment) {
    return {
      appointment_id: a.id,
      service: a.serviceName,
      ...this.slot(a.start),
      ends: fmtTime(a.end),
      ...(a.customerName ? { customer_name: a.customerName } : {}),
      ...(a.vehicle ? { vehicle: a.vehicle } : {}),
    };
  }

  private resolveDay(date: string): { ok: true; day: DateTime; bareWeekdayToday: boolean } | { ok: false; result: ToolResult } {
    const r = resolveDate(date, this.deps.clock());
    if (!r.ok) return { ok: false, result: { ok: false, error: `date_${r.reason}`, message: r.message } };
    return { ok: true, day: r.day, bareWeekdayToday: !!r.bareWeekdayToday };
  }

  private resolveStart(date: string, time: string): { ok: true; start: DateTime } | { ok: false; result: ToolResult } {
    const d = this.resolveDay(date);
    if (!d.ok) return d;
    const t = parseTime(time);
    if (!t.ok) return { ok: false, result: { ok: false, error: 'time_unparseable', message: t.message } };
    let start = d.day.set({ hour: t.hour, minute: t.minute, second: 0, millisecond: 0 });
    // "Thursday at 3:30" said on a Thursday after that time can no longer be booked means next Thursday.
    if (d.bareWeekdayToday && start < this.deps.clock().plus({ minutes: SHOP.minLeadMinutes })) {
      start = start.plus({ days: 7 });
    }
    return { ok: true, start };
  }

  private phone(input: string | undefined, ctx: ToolContext): { ok: true; phone: string } | { ok: false; result: ToolResult } {
    // Only an explicit "caller_id" / "same number" means the number the call came from.
    // Anything else must be a real number, so a garbled one is re-asked rather than replaced.
    const useCallerId = !input || CALLER_ID_SENTINEL.test(input.trim());
    const given = useCallerId ? undefined : input;
    const phone = given ? normalizePhone(given) : normalizePhone(ctx.callerId);
    if (!phone) {
      return {
        ok: false,
        result: {
          ok: false,
          error: 'invalid_phone',
          message: given
            ? `"${given}" is not a complete phone number (10 digits are needed). Ask the caller to repeat their number.`
            : 'A phone number is needed. Ask the caller for the best number to reach them.',
        },
      };
    }
    return { ok: true, phone };
  }

  /** Text chat always reads the calendar live. Voice may use the 30-second cache for questions. */
  private fresh(ctx: ToolContext): boolean {
    return ctx.channel === 'chat';
  }

  // ---------- definitions ----------

  private build(): ToolDef[] {
    const { scheduler, tracker, contacts, clock } = this.deps;

    const checkAvailability: ToolDef = {
      spec: {
        name: 'check_availability',
        description:
          'Check the live calendar. With a time: says whether that exact start time is open for the service and, if not, gives the nearest open times. ' +
          'Without a time: lists every open start time that day. Always call this before telling a caller whether a time is available.',
        parameters: {
          type: 'object',
          properties: {
            service: { type: 'string', enum: SERVICE_IDS, description: SERVICE_DESC },
            date: { type: 'string', description: DATE_DESC },
            time: { type: 'string', description: `${TIME_DESC} Leave out to list all open times that day.` },
          },
          required: ['service', 'date'],
        },
      },
      fillers: ['Let me check.', 'One sec, let me look.', 'Let me take a look.'],
      schema: z.object({
        service: z.enum(SERVICE_IDS),
        date: z.string().min(1),
        time: optionalText,
      }),
      run: async (args: { service: string; date: string; time?: string }, ctx) => {
        const service = getService(args.service)!;
        const now = clock();
        const base = { service: service.name, takes: durationLabel(service.durationMinutes) };

        if (args.time) {
          const r = this.resolveStart(args.date, args.time);
          if (!r.ok) return r.result;
          const check = await scheduler.checkSlot(service.durationMinutes, r.start, { fresh: this.fresh(ctx) });
          if (check.ok) {
            return { ok: true, available: true, ...base, slot: this.slot(r.start) };
          }
          const alt = await scheduler.alternatives(service.durationMinutes, r.start);
          return {
            ok: true,
            available: false,
            ...base,
            requested: this.slot(r.start),
            reason: check.problem,
            message: check.message,
            nearest_open_times: this.alternatives(alt),
          };
        }

        const d = this.resolveDay(args.date);
        if (!d.ok) return d.result;
        const starts = await scheduler.openStarts(service.durationMinutes, d.day, { fresh: this.fresh(ctx) });
        const day = { date: isoDate(d.day), spoken: fmtDay(d.day, now), hours: hoursLabel(d.day) };
        if (starts.length) {
          return {
            ok: true,
            ...base,
            day,
            open_start_times: starts.map((t) => ({ time: hhmm(t), spoken: fmtTime(t) })),
            note: 'Offer two or three of these rather than reading the whole list.',
          };
        }
        const next = await scheduler.nextOpenDays(service.durationMinutes, d.day);
        const reason = (await scheduler.dayProblem(d.day)) ?? 'There are no open times left that day.';
        return {
          ok: true,
          ...base,
          day,
          open_start_times: [],
          message: reason,
          next_days_with_openings: next.map((n) => ({
            date: isoDate(n.day),
            spoken: fmtDay(n.day, now),
            first_open_times: n.starts.slice(0, 4).map((t) => ({ time: hhmm(t), spoken: fmtTime(t) })),
          })),
        };
      },
    };

    const bookAppointment: ToolDef = {
      spec: {
        name: 'book_appointment',
        description:
          'Create the appointment on the calendar. Only call this after the caller has agreed to a specific service, day and time and has given their name and phone number. ' +
          'The appointment exists only if this returns booked: true.',
        parameters: {
          type: 'object',
          properties: {
            service: { type: 'string', enum: SERVICE_IDS, description: SERVICE_DESC },
            date: { type: 'string', description: DATE_DESC },
            time: { type: 'string', description: TIME_DESC },
            customer_name: { type: 'string', description: 'Name the caller gave.' },
            phone: { type: 'string', description: PHONE_DESC },
            vehicle: { type: 'string', description: 'Year, make and model if the caller mentioned it, for example "2021 Honda CR-V".' },
            notes: { type: 'string', description: 'Anything staff should know: add-ons wanted, pet hair, stains, special requests.' },
          },
          required: ['service', 'date', 'time', 'customer_name', 'phone'],
        },
      },
      fillers: ['Okay, booking that now.', 'Got it, one moment.', 'Perfect, let me get that in.'],
      mutates: true,
      schema: z.object({
        service: z.enum(SERVICE_IDS),
        date: z.string().min(1),
        time: z.string().min(1),
        customer_name: z.string().trim().min(2),
        phone: phoneText,
        vehicle: optionalText,
        notes: optionalText,
      }),
      run: async (
        args: { service: string; date: string; time: string; customer_name: string; phone: string; vehicle?: string; notes?: string },
        ctx,
      ) => {
        const service = getService(args.service)!;
        if (/^(unknown|caller|customer|n\/?a|none|name|anonymous)$/i.test(args.customer_name)) {
          return { ok: false, booked: false, error: 'missing_name', message: 'Ask the caller for their name before booking.' };
        }
        const p = this.phone(args.phone, ctx);
        if (!p.ok) return { ...p.result, booked: false };
        const r = this.resolveStart(args.date, args.time);
        if (!r.ok) return { ...r.result, booked: false };

        const res = await scheduler.book({
          service,
          start: r.start,
          name: args.customer_name,
          phone: p.phone,
          vehicle: args.vehicle || undefined,
          notes: args.notes || undefined,
          callId: ctx.callId,
          channel: ctx.channel,
        });
        if (!res.ok) {
          return {
            ok: false,
            booked: false,
            error: res.problem,
            message: `${res.message} Nothing was booked.`,
            requested: this.slot(r.start),
            nearest_open_times: this.alternatives(res.alternatives),
          };
        }
        tracker.identify(ctx.callId, { phone: p.phone, name: args.customer_name, vehicle: args.vehicle });
        if (!res.duplicate) {
          tracker.record(
            ctx.callId,
            'booking',
            `Booked ${service.name} for ${args.customer_name} on ${fmtDayTime(res.appointment.start, clock())}` +
              (args.vehicle ? ` (${args.vehicle})` : '') +
              (args.notes ? `. Notes: ${args.notes}` : ''),
          );
        }
        return {
          ok: true,
          booked: true,
          ...(res.duplicate ? { note: 'This exact appointment was already on the calendar; no second one was created.' } : {}),
          appointment: this.appointment(res.appointment),
          customer: { name: args.customer_name, phone: prettyPhone(p.phone) },
        };
      },
    };

    const lookupAppointments: ToolDef = {
      spec: {
        name: 'lookup_appointments',
        description:
          'Find a caller\'s upcoming appointments by the phone number they booked with. Call this before rescheduling, cancelling, or handling a caller who is running late. ' +
          'Returns the appointment_id needed by the other tools.',
        parameters: {
          type: 'object',
          properties: { phone: { type: 'string', description: PHONE_DESC } },
          required: ['phone'],
        },
      },
      fillers: ['Let me pull that up.', 'One sec, let me find you.'],
      schema: z.object({ phone: phoneText }),
      run: async (args: { phone: string }, ctx) => {
        const p = this.phone(args.phone, ctx);
        if (!p.ok) return p.result;
        const [appts, contact] = await Promise.all([
          scheduler.findUpcomingByPhone(p.phone, { fresh: this.fresh(ctx) }),
          contacts.getContact(p.phone).catch(() => null),
        ]);
        const name = appts.find((a) => a.customerName)?.customerName ?? contact?.name ?? undefined;
        tracker.identify(ctx.callId, { phone: p.phone, name });
        if (!appts.length) {
          return {
            ok: true,
            found: 0,
            phone: prettyPhone(p.phone),
            ...(name ? { customer_name: name } : {}),
            message:
              'No upcoming appointments under that number. Read the number back to check it. If they booked under a different number, ask for it. Otherwise offer to book a new appointment.',
          };
        }
        return {
          ok: true,
          found: appts.length,
          phone: prettyPhone(p.phone),
          ...(name ? { customer_name: name } : {}),
          appointments: appts.map((a) => this.appointment(a)),
        };
      },
    };

    const rescheduleAppointment: ToolDef = {
      spec: {
        name: 'reschedule_appointment',
        description:
          'Move an existing appointment to a new day and time. Needs the appointment_id from lookup_appointments. ' +
          'The appointment has moved only if this returns rescheduled: true; otherwise it is unchanged.',
        parameters: {
          type: 'object',
          properties: {
            appointment_id: { type: 'string', description: 'appointment_id from lookup_appointments.' },
            phone: { type: 'string', description: `${PHONE_DESC} Must be the number the appointment is under.` },
            new_date: { type: 'string', description: DATE_DESC },
            new_time: { type: 'string', description: TIME_DESC },
          },
          required: ['appointment_id', 'phone', 'new_date', 'new_time'],
        },
      },
      fillers: ['Okay, moving that now.', 'Sure, one moment.'],
      mutates: true,
      schema: z.object({
        appointment_id: z.string().min(1),
        phone: phoneText,
        new_date: z.string().min(1),
        new_time: z.string().min(1),
      }),
      run: async (args: { appointment_id: string; phone: string; new_date: string; new_time: string }, ctx) => {
        const p = this.phone(args.phone, ctx);
        if (!p.ok) return { ...p.result, rescheduled: false };
        const r = this.resolveStart(args.new_date, args.new_time);
        if (!r.ok) return { ...r.result, rescheduled: false };
        const res = await scheduler.reschedule({ appointmentId: args.appointment_id, phone: p.phone, newStart: r.start });
        if (!res.ok) {
          return {
            ok: false,
            rescheduled: false,
            error: res.problem,
            message: `${res.message} The appointment has not been changed.`,
            requested: this.slot(r.start),
            ...(res.alternatives ? { nearest_open_times: this.alternatives(res.alternatives) } : {}),
          };
        }
        tracker.identify(ctx.callId, { phone: p.phone, name: res.appointment.customerName });
        if (res.unchanged) {
          return {
            ok: true,
            rescheduled: false,
            note: 'The appointment is already at that time; nothing changed.',
            appointment: this.appointment(res.appointment),
          };
        }
        tracker.record(
          ctx.callId,
          'reschedule',
          `Moved ${res.appointment.serviceName} from ${fmtDayTime(res.previousStart, clock())} to ${fmtDayTime(res.appointment.start, clock())}`,
        );
        return {
          ok: true,
          rescheduled: true,
          previous: this.slot(res.previousStart),
          appointment: this.appointment(res.appointment),
        };
      },
    };

    const cancelAppointment: ToolDef = {
      spec: {
        name: 'cancel_appointment',
        description:
          'Cancel an existing appointment. Needs the appointment_id from lookup_appointments. Only call after the caller has clearly confirmed they want that specific appointment cancelled.',
        parameters: {
          type: 'object',
          properties: {
            appointment_id: { type: 'string', description: 'appointment_id from lookup_appointments.' },
            phone: { type: 'string', description: `${PHONE_DESC} Must be the number the appointment is under.` },
          },
          required: ['appointment_id', 'phone'],
        },
      },
      fillers: ['Okay, cancelling that now.', 'Sure, one moment.'],
      mutates: true,
      schema: z.object({ appointment_id: z.string().min(1), phone: phoneText }),
      run: async (args: { appointment_id: string; phone: string }, ctx) => {
        const p = this.phone(args.phone, ctx);
        if (!p.ok) return { ...p.result, cancelled: false };
        const res = await scheduler.cancel({ appointmentId: args.appointment_id, phone: p.phone });
        if (!res.ok) return { ok: false, cancelled: false, error: res.problem, message: res.message };
        tracker.identify(ctx.callId, { phone: p.phone, name: res.appointment.customerName });
        tracker.record(
          ctx.callId,
          'cancellation',
          `Cancelled ${res.appointment.serviceName} on ${fmtDayTime(res.appointment.start, clock())}`,
        );
        return { ok: true, cancelled: true, appointment: this.appointment(res.appointment) };
      },
    };

    const reportRunningLate: ToolDef = {
      spec: {
        name: 'report_running_late',
        description:
          'Record that a caller will arrive late for an appointment today and find out whether the appointment can still go ahead. ' +
          'Needs the appointment_id from lookup_appointments and how many minutes after the appointment time they expect to arrive.',
        parameters: {
          type: 'object',
          properties: {
            appointment_id: { type: 'string', description: 'appointment_id from lookup_appointments.' },
            phone: { type: 'string', description: `${PHONE_DESC} Must be the number the appointment is under.` },
            minutes_late: {
              type: 'integer',
              description:
                'How many minutes late the caller says they will be. Ask if they have not said. (If the appointment time has already passed, this is how many minutes until they arrive.)',
            },
          },
          required: ['appointment_id', 'phone', 'minutes_late'],
        },
      },
      fillers: ['Thanks for letting us know, one sec.', 'Okay, let me note that.'],
      mutates: true,
      schema: z.object({
        appointment_id: z.string().min(1),
        phone: phoneText,
        minutes_late: z.coerce.number().int().min(1).max(480),
      }),
      run: async (args: { appointment_id: string; phone: string; minutes_late: number }, ctx) => {
        const p = this.phone(args.phone, ctx);
        if (!p.ok) return p.result;
        const res = await scheduler.reportLate({ appointmentId: args.appointment_id, phone: p.phone, minutesLate: args.minutes_late });
        if (!res.ok) return { ok: false, error: res.problem, message: res.message };
        tracker.identify(ctx.callId, { phone: p.phone, name: res.appointment.customerName });
        const what = `${res.appointment.serviceName} at ${fmtTime(res.appointment.start)}`;
        const common = {
          ok: true,
          noted: true,
          appointment: this.appointment(res.appointment),
          expected_arrival: fmtTime(res.expectedArrival),
          minutes_after_appointment_time: res.minutesLate,
        };
        if (res.withinGrace) {
          tracker.record(ctx.callId, 'running_late', `Running ${res.minutesLate} min late for ${what}; within grace period, appointment held`);
          return {
            ...common,
            outcome: 'held',
            message: `That is within our ${SHOP.lateGraceMinutes}-minute grace period. The appointment stays as booked and the team has been told.`,
          };
        }
        if (res.laterToday) {
          tracker.record(
            ctx.callId,
            'running_late',
            `Running ${res.minutesLate} min late for ${what}; beyond grace period, offered ${fmtTime(res.laterToday)} today`,
          );
          return {
            ...common,
            outcome: 'needs_new_time',
            message:
              `That is past our ${SHOP.lateGraceMinutes}-minute grace period, so the original time cannot be held. ` +
              `There is room to start at ${fmtTime(res.laterToday)} today instead. Offer that; if they agree, call reschedule_appointment with it.`,
            later_today: this.slot(res.laterToday),
          };
        }
        tracker.record(
          ctx.callId,
          'running_late',
          `Running ${res.minutesLate} min late for ${what}; beyond grace period and no later opening today`,
        );
        return {
          ...common,
          outcome: 'needs_new_day',
          message:
            `That is past our ${SHOP.lateGraceMinutes}-minute grace period and there is no later opening today that fits the full service. ` +
            'Offer to move the appointment to one of these times (use reschedule_appointment), or keep looking with check_availability.',
          other_days: res.otherDays.map((t) => this.slot(t)),
        };
      },
    };

    const requestHumanFollowup: ToolDef = {
      spec: {
        name: 'request_human_followup',
        description:
          'Hand something to the shop team when it is outside what you can do: billing or charge disputes, refunds, damage or quality complaints, custom quotes, vehicles that need manager approval, ' +
          'or a caller who asks for a person. Logs the request so a team member calls back. Get the caller\'s name and callback number first.',
        parameters: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: FOLLOWUP_CATEGORIES },
            summary: {
              type: 'string',
              description:
                'What the team needs to know, in the caller\'s terms: what happened, relevant dates and amounts, and what the caller wants.',
            },
            customer_name: { type: 'string', description: 'Name the caller gave.' },
            phone: { type: 'string', description: `${PHONE_DESC} This is the callback number.` },
          },
          required: ['category', 'summary', 'customer_name', 'phone'],
        },
      },
      fillers: ['Let me make a note of that.', 'Okay, I\'m writing that down.'],
      schema: z.object({
        category: z.enum(FOLLOWUP_CATEGORIES),
        summary: z.string().trim().min(10),
        customer_name: z.string().trim().min(2),
        phone: phoneText,
      }),
      run: async (args: { category: (typeof FOLLOWUP_CATEGORIES)[number]; summary: string; customer_name: string; phone: string }, ctx) => {
        const p = this.phone(args.phone, ctx);
        if (!p.ok) return { ...p.result, logged: false };
        tracker.identify(ctx.callId, { phone: p.phone, name: args.customer_name });
        const reason: Reason = args.category === 'billing_dispute' ? 'billing_complaint' : 'human_handoff';
        const detail = `[${args.category}] ${args.summary} - call back ${args.customer_name} at ${prettyPhone(p.phone)}`;
        tracker.record(ctx.callId, reason, `Handed to the team: ${detail}`, detail);
        const openNow = isOpenNow(clock());
        return {
          ok: true,
          logged: true,
          callback_number: prettyPhone(p.phone),
          message:
            `Logged for the team. Tell the caller a team member will call them back at ${prettyPhone(p.phone)} ${SHOP.callbackPromise}. ` +
            'Do not promise any particular outcome.',
          ...(this.deps.canTransfer && ctx.channel === 'voice'
            ? { live_transfer: openNow ? 'available now if the caller would rather not wait' : 'not available, the shop is closed right now' }
            : {}),
        };
      },
    };

    return [
      checkAvailability,
      bookAppointment,
      lookupAppointments,
      rescheduleAppointment,
      cancelAppointment,
      reportRunningLate,
      requestHumanFollowup,
    ];
  }
}

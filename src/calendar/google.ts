import { auth, calendar, type calendar_v3 } from '@googleapis/calendar';
import { DateTime } from 'luxon';
import { googleAuthOptions } from '../google/credentials.js';
import { SHOP } from '../shop.js';
import type { CalEvent, CalendarStore, EventPatch, ListOptions, NewEvent } from './types.js';

/** How long a cached read may be served. Writes always re-read first. */
const CACHE_TTL_MS = 30_000;
/** The cached window: yesterday through this many days ahead. */
const WINDOW_DAYS = 35;

interface CachedWindow {
  fromMs: number;
  toMs: number;
  fetchedAt: number;
  events: CalEvent[];
}

/**
 * Google Calendar backed store.
 *
 * Reads for availability questions are served from a short-lived in-memory window
 * (one API call covers the next five weeks), which keeps voice tool calls fast.
 * Anything that changes the calendar passes `fresh: true` first and clears the
 * window afterwards, so a booking is never decided on stale data.
 */
export class GoogleCalendar implements CalendarStore {
  private api: calendar_v3.Calendar;
  private window: CachedWindow | null = null;
  private inflight: Promise<CachedWindow> | null = null;

  constructor(private calendarId: string) {
    // A hung request would otherwise hold the booking lock indefinitely.
    this.api = calendar({ version: 'v3', auth: new auth.GoogleAuth(googleAuthOptions()), timeout: 15_000 });
  }

  private toEvent(e: calendar_v3.Schema$Event): CalEvent | null {
    if (!e.id || e.status === 'cancelled') return null;
    let start: DateTime;
    let end: DateTime;
    const allDay = !!e.start?.date;
    if (allDay) {
      start = DateTime.fromISO(e.start!.date!, { zone: SHOP.timezone }).startOf('day');
      end = DateTime.fromISO(e.end?.date ?? e.start!.date!, { zone: SHOP.timezone }).startOf('day');
      if (end <= start) end = start.plus({ days: 1 });
    } else if (e.start?.dateTime && e.end?.dateTime) {
      start = DateTime.fromISO(e.start.dateTime, { setZone: true });
      end = DateTime.fromISO(e.end.dateTime, { setZone: true });
    } else {
      return null;
    }
    if (!start.isValid || !end.isValid) return null;
    return {
      id: e.id,
      start: start.toUTC().toISO()!,
      end: end.toUTC().toISO()!,
      allDay,
      summary: e.summary ?? '',
      description: e.description ?? '',
      busy: e.transparency !== 'transparent',
      props: { ...(e.extendedProperties?.private ?? {}) },
    };
  }

  private async fetchRange(fromISO: string, toISO: string, extra: Partial<calendar_v3.Params$Resource$Events$List> = {}) {
    const out: CalEvent[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.api.events.list({
        calendarId: this.calendarId,
        timeMin: fromISO,
        timeMax: toISO,
        singleEvents: true,
        orderBy: 'startTime',
        showDeleted: false,
        maxResults: 250,
        pageToken,
        ...extra,
      });
      for (const item of res.data.items ?? []) {
        const ev = this.toEvent(item);
        if (ev) out.push(ev);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  /** Bumped by every write so a read that started before the write cannot repopulate the cache. */
  private generation = 0;

  private invalidate(): void {
    this.window = null;
    this.inflight = null;
    this.generation++;
  }

  /**
   * Fetch the standard window. Cached reads may share one in-flight request;
   * fresh reads always issue their own so they observe every earlier write.
   */
  private loadWindow(join: boolean): Promise<CachedWindow> {
    if (join && this.inflight) return this.inflight;
    const generation = this.generation;
    const from = DateTime.now().setZone(SHOP.timezone).startOf('day').minus({ days: 1 });
    const to = from.plus({ days: WINDOW_DAYS + 1 });
    const p = (async () => {
      const events = await this.fetchRange(from.toUTC().toISO()!, to.toUTC().toISO()!);
      const w: CachedWindow = { fromMs: from.toMillis(), toMs: to.toMillis(), fetchedAt: Date.now(), events };
      if (generation === this.generation) this.window = w;
      return w;
    })();
    if (join) {
      this.inflight = p;
      const clear = () => {
        if (this.inflight === p) this.inflight = null;
      };
      p.then(clear, clear);
    }
    return p;
  }

  /** The timezone the calendar itself is set to, e.g. "America/Los_Angeles". */
  async getTimeZone(): Promise<string | undefined> {
    const res = await this.api.calendars.get({ calendarId: this.calendarId });
    return res.data.timeZone ?? undefined;
  }

  async prewarm(): Promise<void> {
    if (!this.window || Date.now() - this.window.fetchedAt > CACHE_TTL_MS) await this.loadWindow(true);
  }

  async listEvents(fromISO: string, toISO: string, opts: ListOptions = {}): Promise<CalEvent[]> {
    const fromMs = new Date(fromISO).getTime();
    const toMs = new Date(toISO).getTime();
    const overlap = (e: CalEvent) => new Date(e.end).getTime() > fromMs && new Date(e.start).getTime() < toMs;

    let w = this.window;
    const usable = w && !opts.fresh && Date.now() - w.fetchedAt <= CACHE_TTL_MS;
    if (w && usable && fromMs >= w.fromMs && toMs <= w.toMs) return w.events.filter(overlap);

    // Reload the standard window; if the request falls inside it, answer from there.
    const today = DateTime.now().setZone(SHOP.timezone).startOf('day');
    const stdFrom = today.minus({ days: 1 }).toMillis();
    const stdTo = today.plus({ days: WINDOW_DAYS }).toMillis();
    if (fromMs >= stdFrom && toMs <= stdTo) {
      w = await this.loadWindow(!opts.fresh);
      return w.events.filter(overlap);
    }
    return this.fetchRange(fromISO, toISO);
  }

  async findByProp(key: string, value: string, fromISO: string): Promise<CalEvent[]> {
    const to = DateTime.fromISO(fromISO).plus({ days: 400 }).toUTC().toISO()!;
    return this.fetchRange(fromISO, to, { privateExtendedProperty: [`${key}=${value}`] });
  }

  async getEvent(id: string): Promise<CalEvent | null> {
    try {
      const res = await this.api.events.get({ calendarId: this.calendarId, eventId: id });
      return this.toEvent(res.data);
    } catch (err) {
      if (statusOf(err) === 404 || statusOf(err) === 410) return null;
      throw err;
    }
  }

  private static times(startISO: string, endISO: string, allDay: boolean) {
    if (allDay) {
      const s = DateTime.fromISO(startISO, { setZone: true }).setZone(SHOP.timezone);
      const e = DateTime.fromISO(endISO, { setZone: true }).setZone(SHOP.timezone);
      return { start: { date: s.toFormat('yyyy-LL-dd') }, end: { date: e.toFormat('yyyy-LL-dd') } };
    }
    const iso = (v: string) => DateTime.fromISO(v, { setZone: true }).setZone(SHOP.timezone).toISO({ suppressMilliseconds: true })!;
    return {
      start: { dateTime: iso(startISO), timeZone: SHOP.timezone },
      end: { dateTime: iso(endISO), timeZone: SHOP.timezone },
    };
  }

  async createEvent(input: NewEvent): Promise<CalEvent> {
    const res = await this.api.events.insert({
      calendarId: this.calendarId,
      requestBody: {
        summary: input.summary,
        description: input.description,
        ...GoogleCalendar.times(input.start, input.end, input.allDay ?? false),
        transparency: input.busy === false ? 'transparent' : 'opaque',
        extendedProperties: { private: input.props },
      },
    });
    this.invalidate();
    const ev = this.toEvent(res.data);
    if (!ev) throw new Error('Google Calendar returned an unusable event after insert.');
    return ev;
  }

  async updateEvent(id: string, patch: EventPatch): Promise<CalEvent> {
    const current = await this.getEvent(id);
    if (!current) throw new Error(`Event ${id} not found`);
    const body: calendar_v3.Schema$Event = {};
    if (patch.summary !== undefined) body.summary = patch.summary;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.start || patch.end) {
      Object.assign(body, GoogleCalendar.times(patch.start ?? current.start, patch.end ?? current.end, current.allDay));
    }
    if (patch.props) body.extendedProperties = { private: { ...current.props, ...patch.props } };
    const res = await this.api.events.patch({ calendarId: this.calendarId, eventId: id, requestBody: body });
    this.invalidate();
    const ev = this.toEvent(res.data);
    if (!ev) throw new Error('Google Calendar returned an unusable event after update.');
    return ev;
  }

  async deleteEvent(id: string): Promise<void> {
    try {
      await this.api.events.delete({ calendarId: this.calendarId, eventId: id });
    } catch (err) {
      if (statusOf(err) !== 404 && statusOf(err) !== 410) throw err;
    } finally {
      this.invalidate();
    }
  }
}

function statusOf(err: unknown): number | undefined {
  const e = err as { code?: number | string; status?: number; response?: { status?: number } };
  const v = e?.response?.status ?? e?.status ?? e?.code;
  return typeof v === 'string' ? Number.parseInt(v, 10) : v;
}

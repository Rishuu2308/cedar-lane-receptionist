/** A calendar event, reduced to what scheduling needs. Times are ISO instants. */
export interface CalEvent {
  id: string;
  /** ISO instant. For all-day events: midnight (shop time) of the first day. */
  start: string;
  /** ISO instant, exclusive. For all-day events: midnight after the last day. */
  end: string;
  allDay: boolean;
  summary: string;
  description: string;
  /** False for events marked "Free" in Google Calendar (transparency = transparent). */
  busy: boolean;
  /** Private extended properties. Events created by the agent carry phone, name, service... */
  props: Record<string, string>;
}

export interface NewEvent {
  start: string;
  end: string;
  summary: string;
  description: string;
  props: Record<string, string>;
  allDay?: boolean;
  busy?: boolean;
}

export interface EventPatch {
  start?: string;
  end?: string;
  summary?: string;
  description?: string;
  props?: Record<string, string>;
}

export interface ListOptions {
  /**
   * Bypass any cache and read from the source of truth. Every write path
   * (book / reschedule / late-shift) validates against a fresh read.
   */
  fresh?: boolean;
}

export interface CalendarStore {
  /** Events overlapping [fromISO, toISO), excluding cancelled ones. */
  listEvents(fromISO: string, toISO: string, opts?: ListOptions): Promise<CalEvent[]>;
  /** Events ending after fromISO whose private property `key` equals `value`. */
  findByProp(key: string, value: string, fromISO: string): Promise<CalEvent[]>;
  getEvent(id: string): Promise<CalEvent | null>;
  createEvent(input: NewEvent): Promise<CalEvent>;
  updateEvent(id: string, patch: EventPatch): Promise<CalEvent>;
  deleteEvent(id: string): Promise<void>;
  /** Optional: load upcoming events into the cache ahead of the first question. */
  prewarm?(): Promise<void>;
}

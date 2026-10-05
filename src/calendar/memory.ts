import type { CalEvent, CalendarStore, EventPatch, NewEvent } from './types.js';

/** In-process calendar used by tests, evals and STORE=memory demo mode. */
export class MemoryCalendar implements CalendarStore {
  private events = new Map<string, CalEvent>();
  private seq = 0;

  constructor(initial: NewEvent[] = []) {
    for (const e of initial) this.add(e);
  }

  private add(input: NewEvent): CalEvent {
    const id = `evt${String(++this.seq).padStart(4, '0')}`;
    const ev: CalEvent = {
      id,
      start: input.start,
      end: input.end,
      allDay: input.allDay ?? false,
      summary: input.summary,
      description: input.description,
      busy: input.busy ?? true,
      props: { ...input.props },
    };
    this.events.set(id, ev);
    return ev;
  }

  private static ms(iso: string): number {
    return new Date(iso).getTime();
  }

  async listEvents(fromISO: string, toISO: string): Promise<CalEvent[]> {
    const from = MemoryCalendar.ms(fromISO);
    const to = MemoryCalendar.ms(toISO);
    return [...this.events.values()]
      .filter((e) => MemoryCalendar.ms(e.end) > from && MemoryCalendar.ms(e.start) < to)
      .sort((a, b) => MemoryCalendar.ms(a.start) - MemoryCalendar.ms(b.start))
      .map((e) => structuredClone(e));
  }

  async findByProp(key: string, value: string, fromISO: string): Promise<CalEvent[]> {
    const from = MemoryCalendar.ms(fromISO);
    return [...this.events.values()]
      .filter((e) => e.props[key] === value && MemoryCalendar.ms(e.end) > from)
      .sort((a, b) => MemoryCalendar.ms(a.start) - MemoryCalendar.ms(b.start))
      .map((e) => structuredClone(e));
  }

  async getEvent(id: string): Promise<CalEvent | null> {
    const e = this.events.get(id);
    return e ? structuredClone(e) : null;
  }

  async createEvent(input: NewEvent): Promise<CalEvent> {
    return structuredClone(this.add(input));
  }

  async updateEvent(id: string, patch: EventPatch): Promise<CalEvent> {
    const e = this.events.get(id);
    if (!e) throw new Error(`Event ${id} not found`);
    if (patch.start) e.start = patch.start;
    if (patch.end) e.end = patch.end;
    if (patch.summary !== undefined) e.summary = patch.summary;
    if (patch.description !== undefined) e.description = patch.description;
    if (patch.props) e.props = { ...e.props, ...patch.props };
    return structuredClone(e);
  }

  async deleteEvent(id: string): Promise<void> {
    this.events.delete(id);
  }

  /** Test helper. */
  all(): CalEvent[] {
    return [...this.events.values()].map((e) => structuredClone(e));
  }
}

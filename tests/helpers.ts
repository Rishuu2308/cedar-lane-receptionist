import { DateTime } from 'luxon';
import { type App, createApp } from '../src/app.js';
import { MemoryCalendar } from '../src/calendar/memory.js';
import { MemoryContacts } from '../src/contacts/memory.js';
import type { ChatMessage, LlmClient, ToolCall, ToolSpec } from '../src/llm.js';
import { seedContacts, seedEvents } from '../src/seed-data.js';
import { SHOP } from '../src/shop.js';
import { fixedClock } from '../src/time.js';
import type { ToolContext, ToolResult } from '../src/tools.js';

/** Monday, October 5, 2026, 10:00 AM shop time. */
export const MONDAY_10AM = '2026-10-05T10:00:00';

export interface TestApp extends App {
  calendar: MemoryCalendar;
  contacts: MemoryContacts;
  run(name: string, args: unknown, ctx?: Partial<ToolContext>): Promise<ToolResult & Record<string, any>>;
}

export function makeApp(opts: { now?: string; llm?: LlmClient | null; seeded?: boolean } = {}): TestApp {
  const clock = fixedClock(opts.now ?? MONDAY_10AM);
  // Seed data is always laid out relative to Monday morning, whatever time the test runs at.
  const seedNow = fixedClock(MONDAY_10AM)();
  const calendar = new MemoryCalendar(opts.seeded === false ? [] : seedEvents(seedNow));
  const contacts = new MemoryContacts(opts.seeded === false ? [] : seedContacts(seedNow));
  const app = createApp({ clock, calendar, contacts, llm: opts.llm ?? null, canTransfer: false });
  return {
    ...app,
    calendar,
    contacts,
    run: (name, args, ctx = {}) =>
      app.tools.execute(name, args, { callId: 'call-1', channel: 'chat', ...ctx }) as Promise<ToolResult & Record<string, any>>,
  };
}

export function at(date: string, time: string): DateTime {
  return DateTime.fromISO(`${date}T${time}`, { zone: SHOP.timezone });
}

/** An LLM that replays a fixed list of turns and records what it was sent. */
export class ScriptedLlm implements LlmClient {
  calls: { messages: ChatMessage[]; tools: ToolSpec[] }[] = [];
  jsonCalls: { system: string; user: string }[] = [];
  private i = 0;

  constructor(
    private turns: ({ text: string } | { tool: string; args: unknown })[],
    private summary: unknown = {
      reasons: ['booking'],
      summary: 'Scripted summary.',
      follow_up_needed: false,
      follow_up_detail: '',
    },
  ) {}

  async chat(messages: ChatMessage[], tools: ToolSpec[]) {
    this.calls.push({ messages: structuredClone(messages), tools });
    const turn = this.turns[Math.min(this.i, this.turns.length - 1)];
    this.i++;
    if ('text' in turn) return { content: turn.text, toolCalls: [] as ToolCall[] };
    return {
      content: null,
      toolCalls: [{ id: `tc_${this.i}`, name: turn.tool, arguments: JSON.stringify(turn.args) }],
    };
  }

  async json(system: string, user: string) {
    this.jsonCalls.push({ system, user });
    return this.summary;
  }
}

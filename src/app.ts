/** Wires the pieces together. Tests and evals pass their own stores, clock and LLM. */
import { Agent } from './agent.js';
import { GoogleCalendar } from './calendar/google.js';
import { MemoryCalendar } from './calendar/memory.js';
import type { CalendarStore } from './calendar/types.js';
import { CallTracker } from './calls.js';
import { config } from './config.js';
import { GoogleContacts } from './contacts/google.js';
import { MemoryContacts } from './contacts/memory.js';
import type { ContactsStore } from './contacts/types.js';
import { type LlmClient, OpenAiLlm } from './llm.js';
import { Scheduler } from './scheduling.js';
import { seedContacts, seedEvents } from './seed-data.js';
import { makeSummarizer } from './summarize.js';
import { type Clock, systemClock } from './time.js';
import { Tools } from './tools.js';

export interface App {
  clock: Clock;
  calendar: CalendarStore;
  contacts: ContactsStore;
  scheduler: Scheduler;
  tracker: CallTracker;
  tools: Tools;
  /** Null when no LLM is configured (the voice webhook still works; chat does not). */
  agent: Agent | null;
  llm: LlmClient | null;
  storeMode: 'google' | 'memory';
}

export interface AppOptions {
  clock?: Clock;
  calendar?: CalendarStore;
  contacts?: ContactsStore;
  /** Pass null to run without a model. Omit to use OpenAI from the environment. */
  llm?: LlmClient | null;
  idleSummaryMs?: number;
  canTransfer?: boolean;
}

export function createApp(opts: AppOptions = {}): App {
  const clock = opts.clock ?? systemClock;
  let storeMode: 'google' | 'memory' = 'memory';
  let calendar = opts.calendar;
  let contacts = opts.contacts;
  if (!calendar || !contacts) {
    if (config.store === 'google') {
      storeMode = 'google';
      calendar ??= new GoogleCalendar(config.googleCalendarId);
      contacts ??= new GoogleContacts(config.googleSheetId);
    } else {
      calendar ??= new MemoryCalendar(seedEvents(clock()));
      contacts ??= new MemoryContacts(seedContacts(clock()));
    }
  }

  let llm: LlmClient | null;
  if (opts.llm !== undefined) llm = opts.llm;
  else llm = config.openaiApiKey ? new OpenAiLlm() : null;

  const scheduler = new Scheduler(calendar, clock);
  const tracker = new CallTracker({
    contacts,
    scheduler,
    clock,
    summarize: llm ? makeSummarizer(llm) : undefined,
    idleSummaryMs: opts.idleSummaryMs ?? 0,
  });
  const tools = new Tools({
    scheduler,
    tracker,
    contacts,
    clock,
    canTransfer: opts.canTransfer ?? !!config.humanTransferNumber,
  });
  const agent = llm ? new Agent(llm, tools, tracker, clock) : null;
  return { clock, calendar, contacts, scheduler, tracker, tools, agent, llm, storeMode };
}

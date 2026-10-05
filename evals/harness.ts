import './env.js';
import type { ToolTrace } from '../src/agent.js';
import { createApp } from '../src/app.js';
import { MemoryCalendar } from '../src/calendar/memory.js';
import { MemoryContacts } from '../src/contacts/memory.js';
import type { LlmClient } from '../src/llm.js';
import { seedContacts, seedEvents } from '../src/seed-data.js';
import { fixedClock } from '../src/time.js';
import type { Outcome, Scenario } from './scenarios.js';

/** Every eval runs at Monday, October 5, 2026, 10:00 AM shop time. */
export const EVAL_NOW = '2026-10-05T10:00:00';

export async function runScenario(scenario: Scenario, llm: LlmClient): Promise<{ outcome: Outcome; problems: string[] }> {
  const clock = fixedClock(EVAL_NOW);
  const calendar = new MemoryCalendar(seedEvents(clock()));
  const contacts = new MemoryContacts(seedContacts(clock()));
  const app = createApp({ clock, calendar, contacts, llm, canTransfer: false });
  const before = calendar.all();
  const replies: string[] = [];
  const tools: ToolTrace[][] = [];
  const sessionId = `eval-${Math.random().toString(36).slice(2)}`;
  for (const turn of scenario.turns) {
    const { reply, trace } = await app.agent!.respond(sessionId, turn);
    replies.push(reply);
    tools.push(trace);
  }
  await app.agent!.end(sessionId);
  const outcome: Outcome = { app: { ...app, calendar, contacts }, replies, tools, before };
  let problems: string[];
  try {
    problems = scenario.check(outcome);
  } catch (err) {
    problems = [`check crashed: ${err instanceof Error ? err.message : err}`];
  }
  return { outcome, problems };
}

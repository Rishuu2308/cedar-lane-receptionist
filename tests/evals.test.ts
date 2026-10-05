/**
 * Checks the eval harness itself: a model that behaves correctly must pass the
 * scenario checks, and one that misbehaves must fail them. (The real evals need an
 * API key and are run with `npm run eval`.)
 */
import { describe, expect, it } from 'vitest';
import { runScenario } from '../evals/harness.js';
import { SCENARIOS } from '../evals/scenarios.js';
import { ScriptedLlm } from './helpers.js';

const scenario = (part: string) => {
  const s = SCENARIOS.find((x) => x.name.includes(part));
  if (!s) throw new Error(`no scenario matching ${part}`);
  return s;
};

// Seeded events get sequential ids in the in-memory calendar: Dana's is the third, Jordan's the tenth.
const DANA_EVENT = 'evt0003';
const JORDAN_EVENT = 'evt0010';

describe('eval harness', () => {
  it('passes the brief scenario when the agent behaves correctly', async () => {
    const llm = new ScriptedLlm([
      { tool: 'check_availability', args: { service: 'interior_detail_wash', date: 'Thursday', time: '15:30' } },
      { text: "That one's full. The 4:30 is open, want that instead?" },
      { text: 'Got it. Can I get your name and a number to reach you on?' },
      { tool: 'book_appointment', args: { service: 'interior_detail_wash', date: '2026-10-08', time: '16:30', customer_name: 'Sara', phone: '415-555-0190' } },
      { text: "Booked you in for Thursday at 4:30. Anything else?" },
    ]);
    expect((await runScenario(scenario('brief'), llm)).problems).toEqual([]);
  });

  it('fails the brief scenario when the agent claims a booking it never made', async () => {
    const llm = new ScriptedLlm([
      { text: 'Yes, 3:30 is open!' },
      { text: 'Great, name and number?' },
      { text: "You're all set for 3:30 Thursday." },
    ]);
    const { problems } = await runScenario(scenario('brief'), llm);
    expect(problems.length).toBeGreaterThan(2);
    expect(problems.join(' ')).toContain('did not check the calendar');
    expect(problems.join(' ')).toContain('expected exactly one event');
  });

  it('passes the conflict-then-reschedule scenario', async () => {
    const llm = new ScriptedLlm([
      { tool: 'lookup_appointments', args: { phone: '415-555-0142' } },
      { text: 'I see your Exterior Detail on Friday at 10:00 AM. When would you like to move it to?' },
      { tool: 'reschedule_appointment', args: { appointment_id: DANA_EVENT, phone: '415-555-0142', new_date: 'Thursday', new_time: '15:30' } },
      { text: 'Thursday at 3:30 is taken. The closest opening is 4:30 PM, would that work?' },
      { tool: 'reschedule_appointment', args: { appointment_id: DANA_EVENT, phone: '415-555-0142', new_date: '2026-10-08', new_time: '16:30' } },
      { text: "Done, you're now on Thursday, October 8 at 4:30 PM." },
    ]);
    expect((await runScenario(scenario('reschedule into a taken slot'), llm)).problems).toEqual([]);
  });

  it('passes the very-late scenario', async () => {
    const llm = new ScriptedLlm([
      { tool: 'lookup_appointments', args: { phone: '415-555-0177' } },
      { tool: 'report_running_late', args: { appointment_id: JORDAN_EVENT, phone: '415-555-0177', minutes_late: 45 } },
      { text: "That's past our 15 minute grace period, but I can start you at 1:00 PM today instead. Does that work?" },
      { tool: 'reschedule_appointment', args: { appointment_id: JORDAN_EVENT, phone: '415-555-0177', new_date: '2026-10-05', new_time: '13:00' } },
      { text: "You're now set for 1:00 PM today." },
    ]);
    expect((await runScenario(scenario('running very late'), llm)).problems).toEqual([]);
  });

  it('passes the billing complaint scenario, and fails it if a refund is promised', async () => {
    const good = new ScriptedLlm([
      { text: "I'm sorry about that. I can't look into charges myself, but I'll get this to our manager. Can I get your name and a callback number?" },
      {
        tool: 'request_human_followup',
        args: {
          category: 'billing_dispute',
          summary: 'Charged $160 for an interior detail on a Civic last Friday; listed price is $120. Wants the $40 difference back.',
          customer_name: 'Tom Reyes',
          phone: '415-555-0133',
        },
      },
      { text: 'Thanks Tom. A team member will call you back at (415) 555-0133 by the end of the next business day.' },
    ]);
    expect((await runScenario(scenario('billing complaint'), good)).problems).toEqual([]);

    const bad = new ScriptedLlm([
      { text: "Sorry about that, you were overcharged. We'll refund the $40." },
      { text: 'Thanks Tom, you will receive a refund in 3 to 5 days.' },
    ]);
    const { problems } = await runScenario(scenario('billing complaint'), bad);
    expect(problems.join(' ')).toContain('promised money back');
    expect(problems.join(' ')).toContain('expected one handoff');
  });

  it('has a scenario for every kind of call in the brief', () => {
    const areas = new Set(SCENARIOS.map((s) => s.area));
    for (const area of ['booking', 'reschedule', 'cancel', 'pricing', 'hours', 'prep', 'vehicle type', 'complaint', 'running late']) {
      expect(areas.has(area), area).toBe(true);
    }
  });
});

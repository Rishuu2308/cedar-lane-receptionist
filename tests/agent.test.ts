import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/prompt.js';
import { fixedClock } from '../src/time.js';
import { MONDAY_10AM, ScriptedLlm, makeApp } from './helpers.js';

describe('agent loop', () => {
  it('runs the conversation from the brief end to end', async () => {
    const llm = new ScriptedLlm([
      { tool: 'check_availability', args: { service: 'interior_detail_wash', date: 'Thursday', time: '15:30' } },
      { text: "That one's full. The 4:30 is open, want that instead?" },
      { text: 'Got it. Can I get your name and a number to reach you on?' },
      {
        tool: 'book_appointment',
        args: { service: 'interior_detail_wash', date: '2026-10-08', time: '16:30', customer_name: 'Sara', phone: '415-555-0190' },
      },
      { text: 'Booked you in. Anything else?' },
    ]);
    const app = makeApp({ llm });
    const agent = app.agent!;

    const t1 = await agent.respond('s1', 'Is the 3:30 interior detail and wash appointment on Thursday open?');
    expect(t1.reply).toContain('4:30');
    expect(t1.trace).toHaveLength(1);
    expect(t1.trace[0].result).toMatchObject({ available: false });

    await agent.respond('s1', 'Sure, 4:30 works.');
    const t3 = await agent.respond('s1', 'Sara, 415-555-0190.');
    expect(t3.reply).toBe('Booked you in. Anything else?');
    expect(t3.trace[0].result).toMatchObject({ booked: true });

    // The tool result reached the model before it answered.
    const lastCall = llm.calls.at(-1)!;
    const toolMessage = lastCall.messages.findLast((m) => m.role === 'tool')!;
    expect(JSON.parse((toolMessage as { content: string }).content)).toMatchObject({ booked: true });
    // The system prompt is always first and is rebuilt for each turn.
    expect(lastCall.messages[0].role).toBe('system');
    expect(lastCall.messages.filter((m) => m.role === 'system')).toHaveLength(1);

    // Ending the call writes the summary to the log.
    await agent.end('s1');
    expect(app.contacts.callLog).toHaveLength(1);
    expect(app.contacts.callLog[0]).toMatchObject({ status: 'ended', summary: 'Scripted summary.', phone: '+14155550190' });
    expect(llm.jsonCalls[0].user).toContain('Caller: Sure, 4:30 works.');
    expect(llm.jsonCalls[0].user).toContain('Booked Interior Detail & Wash for Sara');
    expect(app.calendar.all().some((e) => e.props.phone === '+14155550190')).toBe(true);
  });

  it('logs a questions-only call when it ends', async () => {
    const llm = new ScriptedLlm([{ text: 'We are open 9 to 4 on Saturdays.' }], {
      reasons: ['hours', 'not_a_real_reason'],
      summary: 'Asked about Saturday hours.',
      follow_up_needed: false,
      follow_up_detail: '',
    });
    const app = makeApp({ llm });
    await app.agent!.respond('s2', 'What time do you close on Saturday?');
    await app.agent!.end('s2');
    expect(app.contacts.callLog[0]).toMatchObject({ reasons: 'hours', summary: 'Asked about Saturday hours.', status: 'ended' });
  });

  it('gives up politely if the model never stops calling tools', async () => {
    const llm = new ScriptedLlm([{ tool: 'check_availability', args: { service: 'express_wash', date: 'Tuesday' } }]);
    const app = makeApp({ llm });
    const out = await app.agent!.respond('s3', 'hello');
    expect(out.reply).toContain('trouble');
    expect(llm.calls.length).toBeLessThan(12);
  });

  it('keeps separate sessions separate and runs turns in order', async () => {
    const llm = new ScriptedLlm([{ text: 'ok' }]);
    const app = makeApp({ llm });
    await Promise.all([app.agent!.respond('a', 'first'), app.agent!.respond('a', 'second'), app.agent!.respond('b', 'other')]);
    const a = app.agent!.session('a').messages.map((m) => m.role);
    expect(a).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(app.agent!.session('b').messages).toHaveLength(2);
  });
});

describe('system prompt', () => {
  const now = fixedClock(MONDAY_10AM)();

  it('states the current date and a dated two-week table for chat', () => {
    const p = buildSystemPrompt({ channel: 'chat', now });
    expect(p).toContain('It is Monday, October 5, 2026, 10:00 AM');
    expect(p).toContain('Thursday Oct 8 (2026-10-08): 8:00 AM to 6:00 PM');
    expect(p).toContain('Sunday Oct 11 (2026-10-11): closed');
    expect(p).toContain('Monday to Friday: 8:00 AM to 6:00 PM; Saturday: 9:00 AM to 4:00 PM; Sunday: closed');
    expect(p).toContain('Interior Detail & Wash (id interior_detail_wash): takes 1 hour. $120 car, $140 SUV, $160 large.');
    expect(p).not.toContain('{{');
  });

  it('lets Vapi fill in the time for a saved assistant', () => {
    const p = buildSystemPrompt({ channel: 'voice', vapiTemplate: true });
    expect(p).toContain('{{"now" | date: "%A, %B %d, %Y, %I:%M %p", "America/Los_Angeles"}}');
    expect(p).toContain('{{customer.number}}');
    expect(p).toContain('How you talk (phone call)');
  });

  it('includes what we know about a recognised caller', () => {
    const p = buildSystemPrompt({
      channel: 'voice',
      now,
      caller: { callerId: '+14155550142', name: 'Dana Kim', upcoming: ['Exterior Detail on Friday, October 9 at 10:00 AM'] },
    });
    expect(p).toContain('(415) 555-0142');
    expect(p).toContain('Dana Kim');
    expect(p).toContain('Exterior Detail on Friday, October 9 at 10:00 AM');
  });
});

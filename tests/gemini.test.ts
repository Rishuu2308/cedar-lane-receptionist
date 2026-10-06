/** The native Gemini client against a fake HTTP endpoint. */
import { describe, expect, it } from 'vitest';
import { GeminiLlm, toGeminiContents } from '../src/gemini.js';
import type { ChatMessage } from '../src/llm.js';
import { makeApp } from './helpers.js';

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

function fakeGemini(respond: (body: Record<string, any>, n: number) => { status?: number; json: unknown }, opts: { apiKey?: string } = {}) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: unknown, init?: { headers?: HeadersInit; body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    seen.push({ url: String(url), headers: new Headers(init?.headers), body });
    const r = respond(body, seen.length);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const llm = new GeminiLlm({ model: 'gemini-3.5-flash', apiKey: opts.apiKey ?? 'AQ.test-key', fetch: fetchImpl, retryDelaysMs: [1, 1], minIntervalMs: 0 });
  return { llm, seen };
}

const reply = (parts: unknown[]) => ({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] });
const TOOLS = [
  {
    name: 'check_availability',
    description: 'Check the calendar',
    parameters: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] },
  },
];

describe('GeminiLlm', () => {
  it('calls the native endpoint with the key as the key query parameter', async () => {
    const { llm, seen } = fakeGemini(() => ({ json: reply([{ text: 'Hello!' }]) }));
    const out = await llm.chat(
      [
        { role: 'system', content: 'You are Riley.' },
        { role: 'user', content: 'Hi' },
      ],
      TOOLS,
    );
    expect(out).toEqual({ content: 'Hello!', toolCalls: [] });
    expect(seen[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=AQ.test-key');
    expect(seen[0].headers.has('x-goog-api-key')).toBe(false);
    expect(seen[0].headers.has('authorization')).toBe(false);
    expect(seen[0].body.systemInstruction).toEqual({ parts: [{ text: 'You are Riley.' }] });
    expect(seen[0].body.contents).toEqual([{ role: 'user', parts: [{ text: 'Hi' }] }]);
    expect(seen[0].body.tools).toEqual([{ functionDeclarations: [TOOLS[0]] }]);
  });

  it('turns a function call into a tool call, then replays the model turn exactly and returns the result', async () => {
    const modelParts = [
      { text: 'planning...', thought: true },
      { functionCall: { name: 'check_availability', args: { date: 'Thursday' } }, thoughtSignature: 'SIG==' },
    ];
    const { llm, seen } = fakeGemini((_b, n) => ({ json: n === 1 ? reply(modelParts) : reply([{ text: '4:30 is open.' }]) }));

    const first = await llm.chat([{ role: 'user', content: 'Is Thursday open?' }], TOOLS);
    expect(first.content).toBeNull(); // thoughts are not shown to the caller
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0]).toMatchObject({ name: 'check_availability', arguments: '{"date":"Thursday"}' });

    const history: ChatMessage[] = [
      { role: 'user', content: 'Is Thursday open?' },
      { role: 'assistant', content: null, toolCalls: first.toolCalls },
      { role: 'tool', toolCallId: first.toolCalls[0].id, content: '{"ok":true,"available":true}' },
    ];
    const second = await llm.chat(history, TOOLS);
    expect(second.content).toBe('4:30 is open.');
    expect(seen[1].body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Is Thursday open?' }] },
      { role: 'model', parts: modelParts }, // signature and all
      { role: 'user', parts: [{ functionResponse: { name: 'check_availability', response: { ok: true, available: true } } }] },
    ]);
  });

  it('groups the results of several calls in one turn and echoes ids Gemini supplied', () => {
    const { contents } = toGeminiContents([
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'a',
            name: 'one',
            arguments: '{}',
            extra: { geminiParts: [{ functionCall: { name: 'one', args: {}, id: 'g1' } }, { functionCall: { name: 'two', args: {}, id: 'g2' } }] },
          },
          { id: 'b', name: 'two', arguments: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'a', content: '{"r":1}' },
      { role: 'tool', toolCallId: 'b', content: 'not json' },
      { role: 'user', content: 'thanks' },
    ]);
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'one', response: { r: 1 }, id: 'g1' } },
        { functionResponse: { name: 'two', response: { result: 'not json' }, id: 'g2' } },
      ],
    });
    expect(contents[3]).toEqual({ role: 'user', parts: [{ text: 'thanks' }] });
  });

  it('rebuilds a model turn when no raw copy was kept', () => {
    const { contents } = toGeminiContents([
      { role: 'assistant', content: 'Sure.', toolCalls: [{ id: 'a', name: 'one', arguments: '{"x":1}' }] },
    ]);
    expect(contents[0]).toEqual({ role: 'model', parts: [{ text: 'Sure.' }, { functionCall: { name: 'one', args: { x: 1 } } }] });
  });

  it('retries when rate limited and then succeeds', async () => {
    const { llm, seen } = fakeGemini((_b, n) =>
      n === 1 ? { status: 429, json: { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } } } : { json: reply([{ text: 'ok' }]) },
    );
    expect((await llm.chat([{ role: 'user', content: 'hi' }], [])).content).toBe('ok');
    expect(seen).toHaveLength(2);
  });

  it('gives up with a clear message when the model stays overloaded', async () => {
    const { llm, seen } = fakeGemini(() => ({ status: 503, json: { error: { code: 503, message: 'high demand', status: 'UNAVAILABLE' } } }));
    await expect(llm.chat([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(/overloaded or this key is out of free quota for gemini-3\.5-flash/);
    expect(seen).toHaveLength(3); // the first try plus two retries
  });

  it('stops at once when the daily free quota is used up, and says which limit', async () => {
    const { llm, seen } = fakeGemini(() => ({
      status: 429,
      json: {
        error: {
          code: 429,
          message: 'You exceeded your current quota, please check your plan and billing details.',
          status: 'RESOURCE_EXHAUSTED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }],
            },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '31s' },
          ],
        },
      },
    }));
    await expect(llm.chat([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(/daily quota.*PerDay.*limit 20.*GEMINI_MODEL/s);
    expect(seen).toHaveLength(1);
  });

  it('retries a per-minute limit', async () => {
    const { llm, seen } = fakeGemini((_b, n) =>
      n === 1
        ? {
            status: 429,
            json: {
              error: {
                code: 429,
                message: 'You exceeded your current quota',
                details: [
                  { violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '5' }] },
                  { retryDelay: '0.001s' },
                ],
              },
            },
          }
        : { json: reply([{ text: 'ok' }]) },
    );
    expect((await llm.chat([{ role: 'user', content: 'hi' }], [])).content).toBe('ok');
    expect(seen).toHaveLength(2);
  });

  it('explains a rejected key and an unknown model', async () => {
    const badKey = fakeGemini(() => ({
      status: 400,
      json: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } },
    }));
    await expect(badKey.llm.chat([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(/rejected the API key.*GEMINI_API_KEY.*aistudio/s);
    expect(badKey.seen).toHaveLength(1);

    const badModel = fakeGemini(() => ({ status: 404, json: { error: { code: 404, message: 'models/x is not found', status: 'NOT_FOUND' } } }));
    await expect(badModel.llm.chat([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(/does not know the model.*GEMINI_MODEL/s);
  });

  it('tries once more after an empty turn', async () => {
    const { llm, seen } = fakeGemini((_b, n) =>
      n === 1 ? { json: { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] } } : { json: reply([{ text: 'ok' }]) },
    );
    expect((await llm.chat([{ role: 'user', content: 'hi' }], TOOLS)).content).toBe('ok');
    expect(seen).toHaveLength(2);
  });

  it('asks for JSON output and parses it', async () => {
    const { llm, seen } = fakeGemini(() => ({ json: reply([{ text: '```json\n{"reasons":["hours"]}\n```' }]) }));
    expect(await llm.json('sys', 'user')).toEqual({ reasons: ['hours'] });
    expect(seen[0].body.generationConfig).toEqual({ responseMimeType: 'application/json' });
    expect(seen[0].body.systemInstruction.parts[0].text).toContain('sys');
  });

  it('refuses the placeholder key', () => {
    expect(() => new GeminiLlm({ apiKey: 'PASTE_YOUR_GEMINI_KEY_HERE' })).toThrow(/placeholder/);
  });

  it('drives the real agent loop through a booking', async () => {
    const { llm, seen } = fakeGemini((_b, n) => {
      if (n === 1) return { json: reply([{ functionCall: { name: 'check_availability', args: { service: 'interior_detail_wash', date: 'Thursday', time: '15:30' } }, thoughtSignature: 's1' }]) };
      if (n === 2) return { json: reply([{ text: "That one's full. 4:30 is open, want that?" }]) };
      if (n === 3) return { json: reply([{ functionCall: { name: 'book_appointment', args: { service: 'interior_detail_wash', date: '2026-10-08', time: '16:30', customer_name: 'Sara', phone: '415-555-0190' } }, thoughtSignature: 's2' }]) };
      return { json: reply([{ text: 'Booked you in. Anything else?' }]) };
    });
    const app = makeApp({ llm });
    const t1 = await app.agent!.respond('g', 'Is the 3:30 interior detail and wash on Thursday open?');
    expect(t1.reply).toContain('4:30');
    const t2 = await app.agent!.respond('g', 'Sure. Sara, 415-555-0190.');
    expect(t2.reply).toBe('Booked you in. Anything else?');
    expect(app.calendar.all().some((e) => e.props.phone === '+14155550190')).toBe(true);
    // Every request declared all seven tools with their parameter schemas.
    expect(seen[0].body.tools[0].functionDeclarations).toHaveLength(7);
    // The last request carried both earlier model turns back with their signatures.
    const modelTurns = seen[3].body.contents.filter((c: any) => c.role === 'model');
    expect(modelTurns.map((c: any) => c.parts[0].thoughtSignature ?? c.parts[0].text)).toEqual(['s1', "That one's full. 4:30 is open, want that?", 's2']);
  });
});

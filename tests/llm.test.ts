/**
 * The model client against a fake HTTP endpoint: checks the request bodies it
 * sends and how it copes with an OpenAI-compatible provider that is stricter
 * than OpenAI (the Gemini case).
 */
import { describe, expect, it } from 'vitest';
import { OpenAiLlm, parseJsonLoosely } from '../src/llm.js';

type Body = Record<string, any>;

function fakeProvider(respond: (body: Body, n: number) => { status?: number; json: unknown }) {
  const bodies: Body[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    bodies.push(body);
    const r = respond(body, bodies.length);
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const llm = new OpenAiLlm({ model: 'test-model', apiKey: 'k', baseURL: 'https://provider.test/v1', fetch: fetchImpl });
  return { llm, bodies };
}

const completion = (message: Record<string, unknown>) => ({
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'test-model',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', ...message } }],
});

const TOOLS = [{ name: 'check_availability', description: 'd', parameters: { type: 'object', properties: {} } }];

describe('OpenAiLlm', () => {
  it('sends the preferred settings and parses tool calls', async () => {
    const { llm, bodies } = fakeProvider(() => ({
      json: completion({
        content: null,
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'check_availability', arguments: '{"date":"Thursday"}' } }],
      }),
    }));
    const out = await llm.chat([{ role: 'user', content: 'hi' }], TOOLS);
    expect(out).toEqual({ content: null, toolCalls: [{ id: 't1', name: 'check_availability', arguments: '{"date":"Thursday"}' }] });
    expect(bodies[0]).toMatchObject({ model: 'test-model', temperature: 0, parallel_tool_calls: false, tool_choice: 'auto' });
    expect(bodies[0].tools[0]).toEqual({ type: 'function', function: TOOLS[0] });
  });

  it("returns provider data attached to a tool call (Gemini's thought signature) unchanged on the next request", async () => {
    const { llm, bodies } = fakeProvider((_b, n) =>
      n === 1
        ? {
            json: completion({
              content: null,
              tool_calls: [
                {
                  id: 't1',
                  type: 'function',
                  function: { name: 'check_availability', arguments: '{}' },
                  extra_content: { google: { thought_signature: 'SIG123' } },
                },
              ],
            }),
          }
        : { json: completion({ content: 'done' }) },
    );
    const first = await llm.chat([{ role: 'user', content: 'hi' }], TOOLS);
    expect(first.toolCalls[0].extra).toEqual({ google: { thought_signature: 'SIG123' } });
    await llm.chat(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, toolCalls: first.toolCalls },
        { role: 'tool', toolCallId: 't1', content: '{"ok":true}' },
      ],
      TOOLS,
    );
    const assistant = bodies[1].messages[1];
    expect(assistant.tool_calls[0].extra_content).toEqual({ google: { thought_signature: 'SIG123' } });
    expect('content' in assistant).toBe(false); // omitted, not null
    expect(bodies[1].messages[2]).toEqual({ role: 'tool', tool_call_id: 't1', content: '{"ok":true}' });
  });

  it('retries once with required parameters only when the provider rejects the request, and remembers', async () => {
    const { llm, bodies } = fakeProvider((body) =>
      'parallel_tool_calls' in body
        ? { status: 400, json: { error: { message: 'Unknown name "parallel_tool_calls"', code: 400 } } }
        : { json: completion({ content: 'hello' }) },
    );
    expect((await llm.chat([{ role: 'user', content: 'hi' }], TOOLS)).content).toBe('hello');
    expect(bodies).toHaveLength(2);
    expect(Object.keys(bodies[1]).sort()).toEqual(['messages', 'model', 'tools']);
    await llm.chat([{ role: 'user', content: 'again' }], TOOLS);
    expect(bodies).toHaveLength(3); // no wasted first attempt the second time
    expect('temperature' in bodies[2]).toBe(false);
  });

  it('surfaces the error when the minimal request is rejected too', async () => {
    const { llm } = fakeProvider(() => ({ status: 400, json: { error: { message: 'model not found' } } }));
    await expect(llm.chat([{ role: 'user', content: 'hi' }], TOOLS)).rejects.toThrow(/model not found/);
  });

  it('falls back from JSON mode and still parses a fenced reply', async () => {
    const { llm, bodies } = fakeProvider((body) =>
      body.response_format
        ? { status: 400, json: { error: { message: 'response_format is not supported' } } }
        : { json: completion({ content: '```json\n{"reasons":["hours"],"summary":"Asked about hours."}\n```' }) },
    );
    expect(await llm.json('sys', 'user')).toEqual({ reasons: ['hours'], summary: 'Asked about hours.' });
    expect(bodies).toHaveLength(2);
  });
});

describe('parseJsonLoosely', () => {
  it('handles plain, fenced and prose-wrapped JSON', () => {
    expect(parseJsonLoosely('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoosely('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoosely('Here you go: {"a":1} Hope that helps.')).toEqual({ a: 1 });
    expect(() => parseJsonLoosely('no json here')).toThrow();
  });
});

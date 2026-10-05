import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { buildAssistant } from '../src/vapi/assistant.js';
import { handleVapiMessage } from '../src/vapi/webhook.js';
import { ScriptedLlm, makeApp } from './helpers.js';

const call = { id: 'vapi-call-1', type: 'inboundPhoneCall', customer: { number: '+14155550190' } };

describe('Vapi tool-calls webhook', () => {
  it('runs tools and answers in the shape Vapi expects', async () => {
    const app = makeApp();
    const res = await handleVapiMessage(
      {
        message: {
          type: 'tool-calls',
          call,
          toolCallList: [
            {
              id: 'toolu_1',
              type: 'function',
              function: { name: 'check_availability', arguments: { service: 'interior_detail_wash', date: 'Thursday', time: '15:30' } },
            },
          ],
        },
      },
      app,
    );
    expect(res.results).toHaveLength(1);
    expect(res.results[0].toolCallId).toBe('toolu_1');
    expect(res.results[0].name).toBe('check_availability');
    expect(typeof res.results[0].result).toBe('string');
    expect(res.results[0].result).not.toMatch(/[\r\n]/);
    expect(JSON.parse(res.results[0].result)).toMatchObject({ available: false, reason: 'full' });
  });

  it('accepts the other documented payload shapes', async () => {
    const app = makeApp();
    const flat = await handleVapiMessage(
      {
        message: {
          type: 'tool-calls',
          call,
          toolCallList: [{ id: 'a', name: 'check_availability', parameters: { service: 'express_wash', date: 'Tuesday', time: '09:00' } }],
        },
      },
      app,
    );
    expect(JSON.parse(flat.results[0].result)).toMatchObject({ available: true });

    const stringArgs = await handleVapiMessage(
      {
        message: {
          type: 'tool-calls',
          call,
          toolWithToolCallList: [
            {
              name: 'check_availability',
              toolCall: {
                id: 'b',
                function: { name: 'check_availability', arguments: '{"service":"express_wash","date":"Tuesday","time":"09:00"}' },
              },
            },
          ],
        },
      },
      app,
    );
    expect(stringArgs.results[0].toolCallId).toBe('b');
    expect(JSON.parse(stringArgs.results[0].result)).toMatchObject({ available: true });
  });

  it('books under caller ID and logs the call when the report arrives', async () => {
    const llm = new ScriptedLlm([{ text: 'unused' }], {
      reasons: ['booking'],
      summary: 'Sara booked an Interior Detail & Wash for Thursday at 4:30 PM.',
      follow_up_needed: false,
      follow_up_detail: '',
    });
    const app = makeApp({ llm });
    const booked = await handleVapiMessage(
      {
        message: {
          type: 'tool-calls',
          call,
          toolCallList: [
            {
              id: 't1',
              type: 'function',
              function: {
                name: 'book_appointment',
                arguments: { service: 'interior_detail_wash', date: 'Thursday', time: '16:30', customer_name: 'Sara', phone: 'caller_id' },
              },
            },
          ],
        },
      },
      app,
    );
    expect(JSON.parse(booked.results[0].result)).toMatchObject({ booked: true, customer: { phone: '(415) 555-0190' } });

    await handleVapiMessage(
      {
        message: {
          type: 'end-of-call-report',
          endedReason: 'customer-ended-call',
          call,
          artifact: {
            messages: [
              { role: 'system', message: 'prompt' },
              { role: 'bot', message: 'Cedar Lane Auto Detailing, this is Riley. How can I help?' },
              { role: 'user', message: 'Can I book the 4:30 interior detail Thursday?' },
              { role: 'bot', message: "You're in for 4:30 Thursday." },
            ],
          },
          analysis: {},
        },
      },
      app,
    );
    await app.tracker.flush();
    expect(app.contacts.callLog).toHaveLength(1);
    expect(app.contacts.callLog[0]).toMatchObject({
      callId: 'vapi-call-1',
      channel: 'voice',
      phone: '+14155550190',
      status: 'ended',
      summary: 'Sara booked an Interior Detail & Wash for Thursday at 4:30 PM.',
    });
    expect(llm.jsonCalls[0].user).toContain('Caller: Can I book the 4:30 interior detail Thursday?');
    expect(llm.jsonCalls[0].user).not.toContain('prompt');
    expect((await app.contacts.getContact('+14155550190'))!.name).toBe('Sara');
  });

  it('logs a voice call that only asked a question, keyed by caller ID', async () => {
    const app = makeApp({ llm: new ScriptedLlm([{ text: 'x' }], { reasons: ['pricing'], summary: 'Asked the price of a full detail.', follow_up_needed: false, follow_up_detail: '' }) });
    await handleVapiMessage(
      {
        message: {
          type: 'end-of-call-report',
          endedReason: 'customer-ended-call',
          call: { id: 'vapi-call-2', customer: { number: '+14155550888' } },
          artifact: { transcript: 'AI: Cedar Lane, this is Riley.\nUser: How much is a full detail?\nAI: $230 for a car.' },
          analysis: {},
        },
      },
      app,
    );
    await app.tracker.flush();
    expect(app.contacts.callLog[0]).toMatchObject({ callId: 'vapi-call-2', reasons: 'pricing', phone: '+14155550888' });
    expect((await app.contacts.getContact('+14155550888'))!.totalCalls).toBe(1);
  });

  it('ignores message types it does not use', async () => {
    const app = makeApp();
    expect(await handleVapiMessage({ message: { type: 'speech-update' } }, app)).toEqual({});
    expect(await handleVapiMessage({}, app)).toEqual({});
  });
});

describe('assistant configuration', () => {
  it('exposes every tool with a filler line and points at this server', () => {
    const app = makeApp();
    const a = buildAssistant({ tools: app.tools, serverUrl: 'https://x.test', secret: 's3cret' }) as any;
    const fns = a.model.tools.filter((t: any) => t.type === 'function');
    expect(fns.map((t: any) => t.function.name)).toEqual(app.tools.specs().map((s) => s.name));
    for (const t of fns) {
      expect(t.server).toEqual({ url: 'https://x.test/vapi/webhook', timeoutSeconds: 20, headers: { 'X-Vapi-Secret': 's3cret' } });
      expect(t.messages.some((m: any) => m.type === 'request-start')).toBe(true);
      expect(t.function.parameters.type).toBe('object');
    }
    expect(a.model.tools.some((t: any) => t.type === 'endCall')).toBe(true);
    expect(a.model.tools.some((t: any) => t.type === 'transferCall')).toBe(false);
    expect(a.serverMessages).toEqual(['tool-calls', 'end-of-call-report', 'status-update']);
    expect(a.model.messages[0].content).toContain('{{"now" | date:');
    // Nothing undefined sneaks into the payload sent to Vapi.
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(a.name.length).toBeLessThanOrEqual(40);
  });

  it('builds a per-call assistant that already knows the caller', async () => {
    const app = makeApp();
    const res = await handleVapiMessage(
      { message: { type: 'assistant-request', call: { id: 'c9', customer: { number: '+14155550142' } } } },
      app,
    );
    const prompt: string = res.assistant.model.messages[0].content;
    expect(prompt).toContain('It is Monday, October 5, 2026, 10:00 AM');
    expect(prompt).toContain('Dana Kim');
    expect(prompt).toContain('Exterior Detail on Friday, October 9 at 10:00 AM');
    expect(prompt).not.toContain('{{');
    expect(res.assistant.server.url).toBe('https://receptionist.example.test/vapi/webhook');
  });
});

describe('HTTP server', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function start(app = makeApp({ llm: new ScriptedLlm([{ text: 'Hello from Riley.' }]) })) {
    const server = createServer(app).listen(0);
    close = () => server.close();
    await new Promise((r) => server.once('listening', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('rejects webhooks without the shared secret', async () => {
    const base = await start();
    const body = { message: { type: 'status-update', status: 'in-progress', call } };
    expect((await post(`${base}/vapi/webhook`, body)).status).toBe(401);
    expect((await post(`${base}/vapi/webhook`, body, { 'X-Vapi-Secret': 'wrong' })).status).toBe(401);
    expect((await post(`${base}/vapi/webhook`, body, { 'X-Vapi-Secret': 'test-secret' })).status).toBe(200);
  });

  it('serves the chat endpoint and the page', async () => {
    const base = await start();
    const res = await post(`${base}/api/chat`, { message: 'hi' });
    const data = (await res.json()) as { sessionId: string; reply: string };
    expect(res.status).toBe(200);
    expect(data.reply).toBe('Hello from Riley.');
    expect(data.sessionId).toBeTruthy();
    expect((await post(`${base}/api/chat`, { message: '   ' })).status).toBe(400);
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('explains when no model is configured', async () => {
    const base = await start(makeApp({ llm: null }));
    const res = await post(`${base}/api/chat`, { message: 'hi' });
    expect(res.status).toBe(503);
  });
});

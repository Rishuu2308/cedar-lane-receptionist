/**
 * Handles the server messages Vapi sends during a call:
 *
 *  - tool-calls           run the same tool handlers the text agent uses
 *  - assistant-request    (optional) build the assistant per call, with today's date and caller details
 *  - status-update        warm the calendar cache as the call connects
 *  - end-of-call-report   write the call log entry and print per-turn latency
 *
 * Payload shapes follow docs.vapi.ai/server-url/events. Vapi's docs show two shapes
 * for tool calls, so both are accepted.
 */
import type { App } from '../app.js';
import type { TranscriptLine } from '../calls.js';
import { config } from '../config.js';
import type { CallerContext } from '../prompt.js';
import { fmtDayTime, normalizePhone } from '../time.js';
import { buildAssistant } from './assistant.js';

type Json = Record<string, any>;

function callInfo(message: Json): { callId: string; callerId?: string } {
  const callId = String(message.call?.id ?? message.chat?.id ?? 'unknown-call');
  const number = message.call?.customer?.number ?? message.customer?.number;
  return { callId, callerId: normalizePhone(number) ?? undefined };
}

/** Vapi requires tool results to be a single-line string. */
function oneLine(value: unknown): string {
  return JSON.stringify(value).replace(/[\r\n]+/g, ' ');
}

async function handleToolCalls(message: Json, app: App): Promise<Json> {
  const { callId, callerId } = callInfo(message);
  app.tracker.start(callId, 'voice', callerId);
  const list: Json[] = message.toolCallList ?? message.toolCalls ?? (message.toolWithToolCallList ?? []).map((t: Json) => t.toolCall);
  const results: Json[] = [];
  for (const tc of list ?? []) {
    if (!tc) continue;
    const name: string = tc.function?.name ?? tc.name ?? '';
    const args: unknown = tc.function?.arguments ?? tc.parameters ?? tc.arguments ?? {};
    const started = Date.now();
    const result = await app.tools.execute(name, args, { callId, channel: 'voice', callerId });
    console.log(`[vapi] ${name} ${result.ok ? 'ok' : `failed (${result.error})`} in ${Date.now() - started} ms`);
    results.push({ toolCallId: tc.id, name, result: oneLine(result) });
  }
  return { results };
}

/** What we already know about the number that is calling. Bounded so it can never hold up the call. */
async function callerContext(app: App, callerId: string | undefined): Promise<CallerContext> {
  if (!callerId) return {};
  const lookup = (async (): Promise<CallerContext> => {
    const [contact, upcoming] = await Promise.all([
      app.contacts.getContact(callerId).catch(() => null),
      app.scheduler.findUpcomingByPhone(callerId).catch(() => []),
    ]);
    return {
      callerId,
      name: contact?.name || upcoming.find((a) => a.customerName)?.customerName,
      vehicle: contact?.vehicle || undefined,
      upcoming: upcoming.slice(0, 3).map((a) => `${a.serviceName} on ${fmtDayTime(a.start, app.clock())}`),
    };
  })();
  const timeout = new Promise<CallerContext>((resolve) => setTimeout(() => resolve({ callerId }), 3000).unref());
  return Promise.race([lookup, timeout]);
}

async function handleAssistantRequest(message: Json, app: App): Promise<Json> {
  const { callId, callerId } = callInfo(message);
  app.tracker.start(callId, 'voice', callerId);
  if (!config.publicUrl) {
    console.error('[vapi] assistant-request received but PUBLIC_URL is not set.');
    return { error: "Sorry, we can't take your call right now. Please try again in a few minutes." };
  }
  const caller = await callerContext(app, callerId);
  return {
    assistant: buildAssistant({
      tools: app.tools,
      serverUrl: config.publicUrl,
      secret: config.vapiWebhookSecret || undefined,
      now: app.clock(),
      caller,
    }),
  };
}

function transcriptFrom(message: Json): TranscriptLine[] {
  const messages: Json[] = message.artifact?.messages ?? message.messages ?? [];
  const lines: TranscriptLine[] = [];
  for (const m of messages) {
    const text = String(m.message ?? m.content ?? '').trim();
    if (!text) continue;
    if (m.role === 'user') lines.push({ role: 'caller', text });
    else if (m.role === 'bot' || m.role === 'assistant') lines.push({ role: 'agent', text });
  }
  if (lines.length) return lines;
  // Fall back to the flat transcript ("AI: ... User: ...").
  const flat = String(message.artifact?.transcript ?? message.transcript ?? '');
  for (const raw of flat.split('\n')) {
    const m = /^(AI|Assistant|Bot|User|Customer):\s*(.+)$/i.exec(raw.trim());
    if (m) lines.push({ role: /^(user|customer)$/i.test(m[1]) ? 'caller' : 'agent', text: m[2] });
  }
  return lines;
}

async function handleEndOfCall(message: Json, app: App): Promise<Json> {
  const { callId, callerId } = callInfo(message);
  app.tracker.start(callId, 'voice', callerId);
  app.tracker.setTranscript(callId, transcriptFrom(message));
  const metrics = message.artifact?.performanceMetrics;
  if (metrics) {
    // Per-turn latency as measured by Vapi: the numbers to watch while tuning.
    console.log(`[vapi] call ${callId} ended (${message.endedReason}). Performance metrics: ${JSON.stringify(metrics)}`);
  } else {
    console.log(`[vapi] call ${callId} ended (${message.endedReason}).`);
  }
  // Respond to Vapi right away; the summary and sheet writes finish in the background.
  void app.tracker.end(callId);
  return {};
}

export async function handleVapiMessage(body: Json, app: App): Promise<Json> {
  const message: Json | undefined = body?.message;
  switch (message?.type) {
    case 'tool-calls':
      return handleToolCalls(message, app);
    case 'assistant-request':
      return handleAssistantRequest(message, app);
    case 'end-of-call-report':
      return handleEndOfCall(message, app);
    case 'status-update': {
      if (message.status === 'in-progress') {
        const { callId, callerId } = callInfo(message);
        app.tracker.start(callId, 'voice', callerId);
        void app.calendar.prewarm?.().catch(() => undefined);
      }
      return {};
    }
    default:
      return {};
  }
}

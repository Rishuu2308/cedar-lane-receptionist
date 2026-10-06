/**
 * Google Gemini through its native REST API (models.generateContent).
 * Request and response shapes follow https://ai.google.dev/api/generate-content.
 */
import { config } from './config.js';
import { type ChatMessage, type LlmClient, type ToolCall, type ToolSpec, parseJsonLoosely } from './llm.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  [key: string]: unknown;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
}

export interface GeminiLlmOptions {
  model?: string;
  apiKey?: string;
  /** Minimum gap between requests, to stay under the free tier's per-minute limit. */
  minIntervalMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
  /** For tests: waits between retries of a rate-limited or overloaded request. */
  retryDelaysMs?: number[];
}

/** The raw parts of a model turn, kept so the turn can be replayed exactly. */
interface ReplayData {
  geminiParts: GeminiPart[];
}

function isReplay(extra: unknown): extra is ReplayData {
  return !!extra && typeof extra === 'object' && Array.isArray((extra as ReplayData).geminiParts);
}

function toObject(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { result: v };
  } catch {
    return { result: json };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Convert the conversation to Gemini's `contents`, with the system prompt split out. */
export function toGeminiContents(messages: ChatMessage[]): { system: string; contents: GeminiContent[] } {
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  // Tool results refer to calls by id; Gemini wants the function name (and its own id, if it gave one).
  const calls = new Map<string, { name: string; geminiId?: string }>();

  for (const m of messages) {
    if (m.role === 'system') {
      system.push(m.content);
    } else if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      if (!m.toolCalls?.length) {
        if (m.content) contents.push({ role: 'model', parts: [{ text: m.content }] });
        continue;
      }
      const replay = m.toolCalls.map((tc) => tc.extra).find(isReplay);
      // Send the model's own turn back exactly as it produced it: Gemini attaches a
      // thoughtSignature to function calls and rejects the follow-up without it.
      const parts: GeminiPart[] = replay
        ? replay.geminiParts
        : [
            ...(m.content ? [{ text: m.content }] : []),
            ...m.toolCalls.map((tc) => ({ functionCall: { name: tc.name, args: toObject(tc.arguments) } })),
          ];
      const geminiIds = parts.filter((p) => p.functionCall).map((p) => p.functionCall!.id);
      m.toolCalls.forEach((tc, i) => calls.set(tc.id, { name: tc.name, geminiId: geminiIds[i] }));
      contents.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      const call = calls.get(m.toolCallId);
      const part: GeminiPart = {
        functionResponse: {
          name: call?.name ?? 'unknown_function',
          response: toObject(m.content),
          ...(call?.geminiId ? { id: call.geminiId } : {}),
        },
      };
      // All results for one model turn go back together in a single user turn.
      const last = contents.at(-1);
      if (last?.role === 'user' && last.parts.every((p) => p.functionResponse)) last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
    }
  }
  return { system: system.join('\n\n'), contents };
}

export class GeminiLlm implements LlmClient {
  private model: string;
  private apiKey: string;
  private minIntervalMs: number;
  private fetchImpl: typeof fetch;
  private retryDelaysMs: number[];
  private nextSlot = 0;
  private callSeq = 0;

  constructor(opts: GeminiLlmOptions = {}) {
    this.apiKey = opts.apiKey ?? config.geminiApiKey;
    if (!this.apiKey) throw new Error('GEMINI_API_KEY is not set. Add it to .env (see .env.example).');
    if (/PASTE_|YOUR[_ ].*KEY|^<.*>$/i.test(this.apiKey)) {
      throw new Error('GEMINI_API_KEY in .env is still the placeholder text. Replace it with your real key and save the file.');
    }
    this.model = (opts.model ?? config.geminiModel).replace(/^models\//, '');
    this.minIntervalMs = opts.minIntervalMs ?? config.llmMinIntervalMs;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.retryDelaysMs = opts.retryDelaysMs ?? [2000, 5000, 15000];
  }

  /** Space requests out when a minimum interval is configured. */
  private async pace(): Promise<void> {
    if (!this.minIntervalMs) return;
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait) await sleep(wait);
  }

  /** POST to generateContent, retrying a few times when rate limited or overloaded. */
  private async post(body: Record<string, unknown>): Promise<GeminiPart[]> {
    // The key goes in the `key` query parameter, as in Google's REST reference.
    const url = `${API_BASE}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        if (attempt < this.retryDelaysMs.length) {
          await sleep(this.retryDelaysMs[attempt]);
          continue;
        }
        // (The URL carries the key, so only the error's own message is reported.)
        throw new Error(`Could not reach Gemini: ${err instanceof Error ? err.message : err}`);
      }
      const text = await res.text();
      if (res.ok) {
        const data = (text ? JSON.parse(text) : {}) as GeminiResponse;
        return data.candidates?.[0]?.content?.parts ?? [];
      }

      let message = text.slice(0, 500);
      let retryAfterMs: number | undefined;
      /** Which free-tier limit was hit, for example "GenerateRequestsPerDayPerProjectPerModel-FreeTier (limit 20)". */
      let quota = '';
      try {
        const parsed = JSON.parse(text);
        const error = (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
        if (error?.message) message = error.message;
        const details: Record<string, any>[] = error?.details ?? [];
        const delay = details.find((d) => d?.retryDelay)?.retryDelay;
        if (typeof delay === 'string' && /^[\d.]+s$/.test(delay)) retryAfterMs = Math.ceil(Number.parseFloat(delay) * 1000);
        quota = details
          .flatMap((d) => d?.violations ?? [])
          .map((v: Record<string, any>) => `${v.quotaId ?? v.quotaMetric ?? 'quota'}${v.quotaValue ? ` (limit ${v.quotaValue})` : ''}`)
          .join(', ');
      } catch {
        // not JSON: keep the raw text
      }

      // A used-up daily allowance will not come back in a few seconds, so do not sit retrying.
      if (res.status === 429 && /PerDay/i.test(quota)) {
        throw new Error(
          `The free daily quota for ${this.model} is used up: ${quota}. It resets at midnight Pacific time. ` +
            'Until then, set GEMINI_MODEL in .env to another model (for example gemini-3.5-flash-lite) and restart.',
        );
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.retryDelaysMs.length) {
        const wait = Math.min(retryAfterMs ?? this.retryDelaysMs[attempt], 30_000);
        console.warn(
          `[llm] ${this.model} returned ${res.status} (${quota || message.slice(0, 120)}). Retrying in ${Math.round(wait / 1000)} s.`,
        );
        await sleep(wait);
        continue;
      }
      if (res.status === 401 || res.status === 403 || /api[ _-]?key/i.test(message)) {
        throw new Error(
          `Gemini rejected the API key (${res.status} ${message}). Check GEMINI_API_KEY in .env: the key itself, no quotes or spaces, from https://aistudio.google.com/apikey.`,
        );
      }
      if (res.status === 404) {
        throw new Error(`Gemini does not know the model "${this.model}" (${message}). Set GEMINI_MODEL in .env to a model your key lists.`);
      }
      if (res.status === 429 || res.status >= 500) {
        throw new Error(
          `Gemini is overloaded or this key is out of free quota for ${this.model} (${res.status} ${quota || message}). Wait a minute and try again.`,
        );
      }
      throw new Error(`Gemini request failed: ${res.status} ${message}`);
    }
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[]) {
    const { system, contents } = toGeminiContents(messages);
    const body: Record<string, unknown> = {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(tools.length
        ? {
            tools: [
              {
                functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
              },
            ],
          }
        : {}),
    };

    let parts = await this.post(body);
    // An empty turn (for example a malformed function call) is worth one more try.
    if (!parts.some((p) => p.functionCall || (p.text && !p.thought))) parts = await this.post(body);

    const text = parts
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim();
    const toolCalls: ToolCall[] = [];
    for (const p of parts) {
      if (!p.functionCall?.name) continue;
      toolCalls.push({
        id: p.functionCall.id ?? `call_${Date.now().toString(36)}_${++this.callSeq}`,
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args ?? {}),
      });
    }
    // Keep the raw turn on the first call so it can be replayed verbatim next request.
    if (toolCalls.length) toolCalls[0].extra = { geminiParts: parts } satisfies ReplayData;
    return { content: text || null, toolCalls };
  }

  async json(system: string, user: string): Promise<unknown> {
    const parts = await this.post({
      contents: [{ role: 'user', parts: [{ text: user }] }],
      systemInstruction: { parts: [{ text: `${system}\nReply with the JSON object only.` }] },
      generationConfig: { responseMimeType: 'application/json' },
    });
    const text = parts
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('');
    return parseJsonLoosely(text || '{}');
  }
}

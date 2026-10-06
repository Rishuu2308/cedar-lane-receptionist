import OpenAI from 'openai';
import { config } from './config.js';

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
  /**
   * Provider-specific data attached to the call that must be sent back unchanged
   * (Gemini's OpenAI-compatible endpoint puts its "thought signature" here).
   */
  extra?: unknown;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmClient {
  /** One model turn: either text, tool calls, or both. */
  chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<{ content: string | null; toolCalls: ToolCall[] }>;
  /** A single JSON-object completion (used for the end-of-call summary). */
  json(system: string, user: string): Promise<unknown>;
}

/** Reasoning-family models reject a custom temperature. */
function supportsTemperature(model: string): boolean {
  return !/^(o\d|gpt-5)/.test(model);
}

function isBadRequest(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 400 || status === 422;
}

/** Pull a JSON object out of a reply that may be wrapped in a code fence or prose. */
export function parseJsonLoosely(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('The model did not return JSON.');
  }
}

export interface OpenAiLlmOptions {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  /** Minimum gap between requests, for providers with a low requests-per-minute limit. */
  minIntervalMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

/**
 * Chat-completions client. Works with OpenAI and with OpenAI-compatible endpoints
 * (Gemini, Groq, ...) by setting OPENAI_BASE_URL.
 *
 * Compatible endpoints differ in which optional parameters they accept, so the
 * first request is sent with the settings we want (temperature 0, one tool call
 * at a time, JSON mode); if the provider rejects it as a bad request, the same
 * request is retried once with only the required fields, and that choice is
 * remembered for the rest of the process.
 */
export class OpenAiLlm implements LlmClient {
  private client: OpenAI;
  private model: string;
  private minIntervalMs: number;
  private nextSlot = 0;
  /** Set after the provider rejects the optional parameters once. */
  private minimal = { chat: false, json: false };

  constructor(opts: OpenAiLlmOptions = {}) {
    const apiKey = opts.apiKey ?? config.openaiApiKey;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set. Add it to .env (see .env.example).');
    }
    this.model = opts.model ?? config.openaiModel;
    this.minIntervalMs = opts.minIntervalMs ?? config.llmMinIntervalMs;
    this.client = new OpenAI({
      apiKey,
      baseURL: opts.baseURL ?? config.openaiBaseUrl,
      // Rate-limit responses (429) are retried with backoff by the SDK.
      maxRetries: 5,
      timeout: 60_000,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  /** Space requests out when a minimum interval is configured. */
  private async pace(): Promise<void> {
    if (!this.minIntervalMs) return;
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  private toApiMessages(messages: ChatMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return messages.map((m): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      if (m.role === 'assistant') {
        if (!m.toolCalls?.length) return { role: 'assistant', content: m.content ?? '' };
        return {
          role: 'assistant',
          // Left out rather than null when the turn was tool calls only: some compatible endpoints reject null.
          ...(m.content ? { content: m.content } : {}),
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
            ...(tc.extra !== undefined ? { extra_content: tc.extra } : {}),
          })),
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[]) {
    const required = {
      model: this.model,
      messages: this.toApiMessages(messages),
      tools: tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    };
    const preferred = {
      ...(supportsTemperature(this.model) ? { temperature: 0 } : {}),
      tool_choice: 'auto' as const,
      // One tool at a time keeps check-then-book sequences in order. (o-series models
      // reject the parameter; the agent loop runs tool calls sequentially either way.)
      ...(/^o\d/.test(this.model) ? {} : { parallel_tool_calls: false }),
    };

    await this.pace();
    let res: OpenAI.Chat.Completions.ChatCompletion;
    if (this.minimal.chat) {
      res = await this.client.chat.completions.create(required);
    } else {
      try {
        res = await this.client.chat.completions.create({ ...required, ...preferred });
      } catch (err) {
        if (!isBadRequest(err)) throw err;
        console.warn(
          `[llm] ${this.model} rejected the request (${(err as Error).message}). Retrying with required parameters only.`,
        );
        await this.pace();
        // If this also fails, the problem is not the optional parameters: let it surface.
        res = await this.client.chat.completions.create(required);
        this.minimal.chat = true;
      }
    }

    const msg = res.choices[0]?.message;
    const toolCalls: ToolCall[] = [];
    for (const tc of msg?.tool_calls ?? []) {
      if (tc.type !== 'function') continue;
      const extra = (tc as unknown as { extra_content?: unknown }).extra_content;
      toolCalls.push({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        ...(extra !== undefined ? { extra } : {}),
      });
    }
    return { content: msg?.content ?? null, toolCalls };
  }

  async json(system: string, user: string): Promise<unknown> {
    const required = {
      model: this.model,
      messages: [
        { role: 'system' as const, content: `${system}\nReply with the JSON object only.` },
        { role: 'user' as const, content: user },
      ],
    };
    const preferred = {
      ...(supportsTemperature(this.model) ? { temperature: 0 } : {}),
      response_format: { type: 'json_object' as const },
    };

    await this.pace();
    let res: OpenAI.Chat.Completions.ChatCompletion;
    if (this.minimal.json) {
      res = await this.client.chat.completions.create(required);
    } else {
      try {
        res = await this.client.chat.completions.create({ ...required, ...preferred });
      } catch (err) {
        if (!isBadRequest(err)) throw err;
        console.warn(`[llm] ${this.model} rejected JSON mode (${(err as Error).message}). Retrying without it.`);
        await this.pace();
        res = await this.client.chat.completions.create(required);
        this.minimal.json = true;
      }
    }
    return parseJsonLoosely(res.choices[0]?.message?.content ?? '{}');
  }
}

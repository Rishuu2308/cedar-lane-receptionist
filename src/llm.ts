import OpenAI from 'openai';
import { config } from './config.js';

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
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

export class OpenAiLlm implements LlmClient {
  private client: OpenAI;

  constructor(
    private model = config.openaiModel,
    apiKey = config.openaiApiKey,
    baseURL = config.openaiBaseUrl,
  ) {
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set. Add it to .env (see .env.example).');
    }
    this.client = new OpenAI({ apiKey, baseURL, maxRetries: 2, timeout: 60_000 });
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[]) {
    const res = await this.client.chat.completions.create({
      model: this.model,
      ...(supportsTemperature(this.model) ? { temperature: 0 } : {}),
      // One tool at a time keeps check-then-book sequences in order. (o-series models
      // reject the parameter; the agent loop runs tool calls sequentially either way.)
      ...(/^o\d/.test(this.model) ? {} : { parallel_tool_calls: false }),
      tool_choice: 'auto',
      tools: tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      messages: messages.map((m): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
        if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
        if (m.role === 'assistant') {
          return {
            role: 'assistant',
            content: m.content,
            ...(m.toolCalls?.length
              ? {
                  tool_calls: m.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: { name: tc.name, arguments: tc.arguments },
                  })),
                }
              : {}),
          };
        }
        return { role: m.role, content: m.content };
      }),
    });
    const msg = res.choices[0]?.message;
    const toolCalls: ToolCall[] = [];
    for (const tc of msg?.tool_calls ?? []) {
      if (tc.type === 'function') toolCalls.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
    }
    return { content: msg?.content ?? null, toolCalls };
  }

  async json(system: string, user: string): Promise<unknown> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      ...(supportsTemperature(this.model) ? { temperature: 0 } : {}),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    return JSON.parse(res.choices[0]?.message?.content ?? '{}');
  }
}

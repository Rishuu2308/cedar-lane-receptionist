/** The small interface the agent needs from a language model. Implemented by GeminiLlm. */

export interface ToolCall {
  id: string;
  name: string;
  /** JSON string of the arguments the model chose. */
  arguments: string;
  /** Model-specific data that must be sent back unchanged with the next request. */
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

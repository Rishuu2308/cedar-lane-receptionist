/**
 * The Phase 1 text agent: a plain tool-calling loop.
 *
 * The loop itself has no business logic. It hands the model the prompt and the
 * tools, executes whatever tools it asks for, feeds the results back, and repeats
 * until the model answers in words.
 */
import type { CallTracker, TranscriptLine } from './calls.js';
import type { ChatMessage, LlmClient } from './llm.js';
import { buildSystemPrompt } from './prompt.js';
import type { Clock } from './time.js';
import type { ToolResult, Tools } from './tools.js';

export interface ToolTrace {
  name: string;
  args: unknown;
  result: ToolResult;
  ms: number;
}

export interface ChatSession {
  id: string;
  /** Conversation so far, without the system prompt (rebuilt every turn so the clock is current). */
  messages: ChatMessage[];
  lastActive: number;
  /** Turns for one session run one at a time, even if two requests arrive together. */
  turn: Promise<unknown>;
}

/** A model that keeps calling tools past this many rounds in one turn is stuck. */
const MAX_TOOL_ROUNDS = 8;

export class Agent {
  private sessions = new Map<string, ChatSession>();

  constructor(
    private llm: LlmClient,
    private tools: Tools,
    private tracker: CallTracker,
    private clock: Clock,
  ) {}

  session(id: string): ChatSession {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, messages: [], lastActive: Date.now(), turn: Promise.resolve() };
      this.sessions.set(id, s);
    }
    return s;
  }

  /** Handle one caller message and return the agent's reply. */
  respond(sessionId: string, userText: string): Promise<{ reply: string; trace: ToolTrace[] }> {
    const session = this.session(sessionId);
    const run = () => this.takeTurn(session, userText);
    const result = session.turn.then(run, run);
    session.turn = result.catch(() => undefined);
    return result;
  }

  private async takeTurn(session: ChatSession, userText: string): Promise<{ reply: string; trace: ToolTrace[] }> {
    const sessionId = session.id;
    session.lastActive = Date.now();
    this.tracker.start(sessionId, 'chat');
    session.messages.push({ role: 'user', content: userText });

    const system: ChatMessage = {
      role: 'system',
      content: buildSystemPrompt({ channel: 'chat', now: this.clock() }),
    };
    const trace: ToolTrace[] = [];
    let reply: string | null = null;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const out = await this.llm.chat([system, ...session.messages], this.tools.specs());
      if (!out.toolCalls.length) {
        // An empty turn (no text, no tools) is not stored: the API rejects it on the next request.
        if (out.content?.trim()) session.messages.push({ role: 'assistant', content: out.content });
        reply = out.content;
        break;
      }
      session.messages.push({ role: 'assistant', content: out.content, toolCalls: out.toolCalls });
      for (const call of out.toolCalls) {
        const started = Date.now();
        const result = await this.tools.execute(call.name, call.arguments, { callId: sessionId, channel: 'chat' });
        trace.push({ name: call.name, args: safeParse(call.arguments), result, ms: Date.now() - started });
        session.messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
      }
    }

    if (!reply || !reply.trim()) {
      // Either the model returned nothing or it never stopped calling tools.
      reply = "Sorry, I'm having trouble with that. Could you say it again, or would you like me to have someone from the team call you back?";
      session.messages.push({ role: 'assistant', content: reply });
    }

    this.tracker.setTranscript(sessionId, transcriptOf(session.messages));
    this.tracker.touch(sessionId);
    return { reply, trace };
  }

  /**
   * The caller hung up / closed the chat: write the final call log entry.
   * The conversation itself is kept, so if the same chat carries on afterwards
   * (an idle tab, a page restored from the back button) nothing is forgotten;
   * the log entry is simply updated again at the next end.
   */
  async end(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) this.tracker.setTranscript(sessionId, transcriptOf(session.messages));
    await this.tracker.end(sessionId);
  }

  /**
   * Finalise the log of chats idle for `finaliseAfterMs`, and forget chats idle for
   * `forgetAfterMs` so memory does not grow without bound.
   */
  async sweep(finaliseAfterMs: number, forgetAfterMs: number): Promise<void> {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      if (now - s.lastActive >= forgetAfterMs) {
        await this.end(s.id);
        this.sessions.delete(s.id);
      } else if (now - s.lastActive >= finaliseAfterMs) {
        await this.end(s.id);
      }
    }
  }
}

export function transcriptOf(messages: ChatMessage[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'caller', text: m.content });
    else if (m.role === 'assistant' && m.content?.trim()) out.push({ role: 'agent', text: m.content });
  }
  return out;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

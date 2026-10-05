import { z } from 'zod';
import { REASONS, type CallSummary, type Summarizer, type TranscriptLine } from './calls.js';
import type { LlmClient } from './llm.js';

const schema = z.object({
  reasons: z.array(z.string()).default([]),
  summary: z.string().default(''),
  follow_up_needed: z.boolean().default(false),
  follow_up_detail: z.string().default(''),
});

const SYSTEM = `You write the call log for an auto detailing shop's receptionist.
Given a call transcript and the list of actions the receptionist's system actually performed, return a JSON object:
{
  "reasons": string[],          // every reason the caller called, chosen only from: ${REASONS.join(', ')}
  "summary": string,            // one or two plain sentences: what the caller wanted and what happened
  "follow_up_needed": boolean,  // true only if the receptionist said a person would get back to the caller, or the caller is still waiting on something from staff
  "follow_up_detail": string    // what the staff member must do, or "" when no follow-up is needed
}
Rules:
- Only state that something was booked, moved or cancelled if it appears in the performed actions.
- Do not invent details. Keep names, dates and times exactly as they appear.
- "pricing", "hours", "prep" and "vehicle_type" are for questions about those topics.`;

/** Builds the function that turns a transcript into a structured call summary. */
export function makeSummarizer(llm: LlmClient): Summarizer {
  return async (transcript: TranscriptLine[], actions: string[]): Promise<CallSummary | null> => {
    const text = transcript.map((l) => `${l.role === 'caller' ? 'Caller' : 'Receptionist'}: ${l.text}`).join('\n');
    const user = `Performed actions:\n${actions.length ? actions.map((a) => `- ${a}`).join('\n') : '(none)'}\n\nTranscript:\n${text}`;
    const parsed = schema.safeParse(await llm.json(SYSTEM, user));
    if (!parsed.success) return null;
    const allowed = new Set<string>(REASONS);
    const reasons = parsed.data.reasons.filter((r) => allowed.has(r)) as CallSummary['reasons'];
    return {
      reasons,
      summary: parsed.data.summary.trim(),
      followUpNeeded: parsed.data.follow_up_needed,
      followUpDetail: parsed.data.follow_up_detail.trim(),
    };
  };
}

/**
 * Per-call bookkeeping and everything written to the spreadsheet.
 *
 * What gets logged is decided in code, not left to the model remembering to call a
 * "log" tool: every tool that changes something records an action here, which is
 * written to the sheet straight away. A short LLM summary of the conversation is
 * added a few seconds after the last message and again when the call ends, so calls
 * that only asked a question ("what are your hours?") are logged too.
 */
import type { DateTime } from 'luxon';
import type { CallLogRow, Contact, ContactsStore } from './contacts/types.js';
import type { Scheduler } from './scheduling.js';
import { type Clock, fmtShort, normalizePhone } from './time.js';

export const REASONS = [
  'booking',
  'reschedule',
  'cancellation',
  'pricing',
  'hours',
  'prep',
  'vehicle_type',
  'running_late',
  'billing_complaint',
  'human_handoff',
  'other',
] as const;
export type Reason = (typeof REASONS)[number];

export interface TranscriptLine {
  role: 'caller' | 'agent';
  text: string;
}

export interface CallSummary {
  reasons: Reason[];
  summary: string;
  followUpNeeded: boolean;
  followUpDetail: string;
}

export interface CallState {
  id: string;
  channel: 'chat' | 'voice';
  startedAt: DateTime;
  /** Number the call came from (voice only), E.164. */
  callerId?: string;
  /** Number the caller gave us. Takes precedence over callerId. */
  phone?: string;
  name?: string;
  vehicle?: string;
  actions: { at: DateTime; reason: Reason; text: string }[];
  followUp?: string;
  summary?: CallSummary;
  transcript: TranscriptLine[];
  ended: boolean;
}

export type Summarizer = (transcript: TranscriptLine[], actions: string[]) => Promise<CallSummary | null>;

export interface CallTrackerDeps {
  contacts: ContactsStore;
  scheduler: Scheduler;
  clock: Clock;
  summarize?: Summarizer;
  /** Chat only: write the summary this long after the last message. 0 disables the timer. */
  idleSummaryMs?: number;
}

const STAMP = 'yyyy-LL-dd h:mm a';
const HISTORY_LINES = 15;

export class CallTracker {
  private calls = new Map<string, CallState>();
  private queue: Promise<void> = Promise.resolve();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private deps: CallTrackerDeps) {}

  start(id: string, channel: 'chat' | 'voice', callerId?: string): CallState {
    let state = this.calls.get(id);
    if (!state) {
      state = {
        id,
        channel,
        startedAt: this.deps.clock(),
        callerId: normalizePhone(callerId) ?? undefined,
        actions: [],
        transcript: [],
        ended: false,
      };
      this.calls.set(id, state);
    } else {
      if (!state.callerId && callerId) state.callerId = normalizePhone(callerId) ?? undefined;
      // Activity on a call we had already closed out (an idle chat that resumes):
      // reopen it so the next end() writes a fresh summary.
      state.ended = false;
    }
    return state;
  }

  get(id: string): CallState | undefined {
    return this.calls.get(id);
  }

  /** Remember who the caller is as soon as a tool learns it. */
  identify(id: string, who: { phone?: string; name?: string; vehicle?: string }): void {
    const state = this.calls.get(id);
    if (!state) return;
    if (who.phone && state.phone && who.phone !== state.phone) {
      // A different number is a different person as far as we know: do not carry the
      // previous number's name or vehicle over to it.
      state.name = undefined;
      state.vehicle = undefined;
    }
    if (who.phone) state.phone = who.phone;
    if (who.name) state.name = who.name;
    if (who.vehicle) state.vehicle = who.vehicle;
  }

  /** Record something the agent did and write it to the sheet immediately. */
  record(id: string, reason: Reason, text: string, followUp?: string): void {
    const state = this.calls.get(id);
    if (!state) return;
    state.actions.push({ at: this.deps.clock(), reason, text });
    if (followUp) state.followUp = followUp;
    this.enqueue(() => this.sync(state));
  }

  setTranscript(id: string, transcript: TranscriptLine[]): void {
    const state = this.calls.get(id);
    if (state) state.transcript = transcript;
  }

  /** Chat: (re)start the idle timer that summarises the conversation so far. */
  touch(id: string): void {
    const ms = this.deps.idleSummaryMs ?? 0;
    if (!ms) return;
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const state = this.calls.get(id);
      if (state && !state.ended) this.enqueue(() => this.summariseAndSync(state));
    }, ms);
    timer.unref();
    this.timers.set(id, timer);
  }

  /** The call is over: write the final summary. Safe to call more than once. */
  end(id: string): Promise<void> {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const state = this.calls.get(id);
    if (!state || state.ended) return this.flush();
    state.ended = true;
    this.enqueue(() => this.summariseAndSync(state));
    return this.flush();
  }

  /** Resolves when every pending sheet write has finished. */
  flush(): Promise<void> {
    return this.queue;
  }

  private enqueue(fn: () => Promise<void>): void {
    // Sheet writes run one at a time and never break the conversation if they fail.
    this.queue = this.queue.then(fn).catch((err) => {
      console.error('[calls] failed to write to the sheet:', err);
    });
  }

  private async summariseAndSync(state: CallState): Promise<void> {
    if (state.transcript.length === 0 && state.actions.length === 0) return;
    if (this.deps.summarize && state.transcript.length > 0) {
      try {
        const summary = await this.deps.summarize(
          state.transcript,
          state.actions.map((a) => a.text),
        );
        if (summary) state.summary = summary;
      } catch (err) {
        console.error('[calls] summary failed, logging actions only:', err);
      }
    }
    await this.sync(state);
  }

  private async sync(state: CallState): Promise<void> {
    const { contacts, scheduler, clock } = this.deps;
    const now = clock();
    const phone = state.phone ?? state.callerId ?? '';

    const reasons = [...new Set<Reason>([...state.actions.map((a) => a.reason), ...(state.summary?.reasons ?? [])])];
    const actionsText = state.actions.map((a) => a.text).join(' | ');
    const summaryText = clip(
      state.summary?.summary || actionsText || (state.ended ? 'No actions taken; summary unavailable.' : 'Call in progress.'),
      600,
    );
    const followUpNeeded = !!state.followUp || !!state.summary?.followUpNeeded;
    const followUpDetail = clip(state.followUp ?? state.summary?.followUpDetail ?? '', 600);
    const reasonsText = reasons.length ? reasons.join(', ') : 'other';

    const existing = phone ? await contacts.getContact(phone) : null;
    const row: CallLogRow = {
      timestamp: state.startedAt.toFormat(STAMP),
      callId: state.id,
      channel: state.channel,
      phone,
      name: state.name || existing?.name || '',
      reasons: reasonsText,
      summary: summaryText,
      actions: actionsText,
      followUpNeeded: followUpNeeded ? 'YES' : 'no',
      followUpDetail,
      status: state.ended ? 'ended' : 'in progress',
    };
    await contacts.saveCallLog(row);

    if (!phone) return;
    // callIds runs parallel to the history lines, so a call that is updated later
    // (or that overlaps with another call from the same number) replaces its own line.
    const history = (existing?.callHistory ?? '').split('\n').filter(Boolean);
    const ids = (existing?.callIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    while (ids.length < history.length) ids.push('');
    const line = `${state.startedAt.toFormat(STAMP)} [${reasonsText}] ${summaryText}`;
    const at = ids.indexOf(state.id);
    const sameCall = at >= 0 && at < history.length;
    if (sameCall) {
      history[at] = line;
    } else {
      history.unshift(line);
      ids.unshift(state.id);
    }

    let nextAppointment = existing?.nextAppointment ?? '';
    try {
      const upcoming = await scheduler.findUpcomingByPhone(phone);
      nextAppointment = upcoming[0] ? `${fmtShort(upcoming[0].start)} - ${upcoming[0].serviceName}` : '';
    } catch (err) {
      console.error('[calls] could not read upcoming appointments:', err);
    }

    const contact: Contact = {
      phone,
      name: state.name || existing?.name || '',
      vehicle: state.vehicle || existing?.vehicle || '',
      firstContact: existing?.firstContact || now.toFormat(STAMP),
      lastContact: now.toFormat(STAMP),
      totalCalls: (existing?.totalCalls ?? 0) + (sameCall ? 0 : 1),
      lastCallReason: reasonsText,
      lastCallSummary: summaryText,
      nextAppointment,
      // Only ever set here; staff clear the cell once they have dealt with it.
      needsFollowUp: followUpNeeded ? followUpDetail || 'Yes' : (existing?.needsFollowUp ?? ''),
      callHistory: history.slice(0, HISTORY_LINES).join('\n'),
      callIds: ids.slice(0, HISTORY_LINES).join(', '),
    };
    await contacts.saveContact(contact);
  }
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

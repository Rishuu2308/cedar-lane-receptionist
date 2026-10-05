/**
 * Builds the Vapi assistant configuration from the same prompt and tool definitions
 * the text agent uses. Field names follow Vapi's assistant schema (docs.vapi.ai,
 * checked October 2026); Vapi rejects unknown properties, so only documented fields
 * are sent. The reasoning behind each latency setting is in the README.
 */
import type { DateTime } from 'luxon';
import { config } from '../config.js';
import { type CallerContext, buildSystemPrompt } from '../prompt.js';
import { SERVICES, SHOP } from '../shop.js';
import type { Tools } from '../tools.js';

export interface AssistantOptions {
  tools: Tools;
  /** Public base URL of this server. */
  serverUrl: string;
  secret?: string;
  /**
   * Per-call build (assistant-request): pass the current time and what we know about
   * the caller. Omit both for the assistant saved in the Vapi dashboard.
   */
  now?: DateTime;
  caller?: CallerContext;
}

export const WEBHOOK_PATH = '/vapi/webhook';
export const SECRET_HEADER = 'X-Vapi-Secret';

function transcriber() {
  const model = config.vapiTranscriberModel;
  const keyterm = [SHOP.name, 'Cedar Lane', 'detailing', ...SERVICES.map((s) => s.name.replace('&', 'and'))];
  if (model.startsWith('flux')) {
    // Flux decides end-of-turn itself, so no separate endpointing plan is sent.
    return { provider: 'deepgram', model, language: 'en', eotThreshold: 0.7, eotTimeoutMs: 3000 };
  }
  return { provider: 'deepgram', model, language: 'en', numerals: true, keyterm };
}

function voice() {
  return {
    provider: config.vapiVoiceProvider,
    voiceId: config.vapiVoiceId,
    // Vapi's own voices take no model; other providers do (for example sonic-3, eleven_flash_v2_5).
    ...(config.vapiVoiceModel && config.vapiVoiceProvider !== 'vapi' ? { model: config.vapiVoiceModel } : {}),
    // Send text to the voice at the first clause boundary instead of waiting for a full sentence.
    chunkPlan: { enabled: true, minCharacters: 20, punctuationBoundaries: ['.', '!', '?', ';', ','] },
  };
}

function startSpeakingPlan() {
  const usesFlux = config.vapiTranscriberModel.startsWith('flux');
  return {
    // Floor on how long we wait after the caller stops before speaking.
    waitSeconds: 0.3,
    ...(usesFlux
      ? {}
      : {
          // Model-based end-of-turn detection: answers quickly after a finished thought,
          // waits longer after an unfinished one. This is Vapi's "aggressive" curve.
          smartEndpointingPlan: { provider: 'livekit', waitFunction: '2000 / (1 + exp(-10 * (x - 0.5)))' },
        }),
    // People pause while reading out a phone number. After we ask for one, give them room.
    customEndpointingRules: [{ type: 'assistant', regex: '([Nn]umber|[Pp]hone)', timeoutSeconds: 1.4 }],
  };
}

export function buildAssistant(opts: AssistantOptions): Record<string, unknown> {
  const dynamic = !!opts.now;
  const server = {
    url: `${opts.serverUrl}${WEBHOOK_PATH}`,
    timeoutSeconds: 20,
    ...(opts.secret ? { headers: { [SECRET_HEADER]: opts.secret } } : {}),
  };
  const canTransfer = !!config.humanTransferNumber;

  const functionTools = opts.tools.specs().map((spec) => ({
    type: 'function',
    async: false,
    function: { name: spec.name, description: spec.description, parameters: spec.parameters },
    server,
    messages: [
      // Spoken the moment the tool is called, so the caller hears a reply while we work.
      ...opts.tools.fillersFor(spec.name).map((content) => ({ type: 'request-start', content, blocking: false })),
      { type: 'request-response-delayed', content: 'Still checking, one moment.', timingMilliseconds: 3500 },
      { type: 'request-failed', content: "Sorry, I'm having trouble reaching our system." },
    ],
  }));

  const builtIns: Record<string, unknown>[] = [{ type: 'endCall' }];
  if (canTransfer) {
    builtIns.push({
      type: 'transferCall',
      destinations: [
        {
          type: 'number',
          number: config.humanTransferNumber,
          description: 'A team member at the shop. Use only when the caller insists on a person now and the shop is open.',
          message: 'Sure, let me put you through to the team. One moment.',
        },
      ],
    });
  }

  return {
    name: `${SHOP.name} Receptionist`,
    firstMessage: `${SHOP.name}, this is ${SHOP.agentName}. How can I help?`,
    firstMessageMode: 'assistant-speaks-first',
    model: {
      provider: 'openai',
      model: config.vapiModel,
      temperature: 0,
      // Replies are one or two sentences; tool-call arguments share this budget.
      maxTokens: 250,
      messages: [
        {
          role: 'system',
          content: buildSystemPrompt(
            dynamic
              ? { channel: 'voice', now: opts.now, caller: opts.caller, canTransfer }
              : { channel: 'voice', vapiTemplate: true, canTransfer },
          ),
        },
      ],
      tools: [...functionTools, ...builtIns],
    },
    voice: voice(),
    transcriber: transcriber(),
    startSpeakingPlan: startSpeakingPlan(),
    // Stop talking as soon as the caller starts (voice-activity based, about 0.2 s).
    stopSpeakingPlan: { numWords: 0, voiceSeconds: 0.2, backoffSeconds: 1 },
    backgroundSound: 'office',
    backgroundSpeechDenoisingPlan: { smartDenoisingPlan: { enabled: true } },
    maxDurationSeconds: 900,
    endCallMessage: 'Thanks for calling Cedar Lane. Bye!',
    hooks: [
      {
        on: 'customer.speech.timeout',
        options: { timeoutSeconds: 10, triggerMaxCount: 2, triggerResetMode: 'onUserSpeech' },
        do: [{ type: 'say', exact: ['Are you still there?', 'Hello, are you still with me?'] }],
      },
      {
        on: 'customer.speech.timeout',
        options: { timeoutSeconds: 30, triggerMaxCount: 1, triggerResetMode: 'onUserSpeech' },
        do: [
          { type: 'say', exact: "I can't hear anyone, so I'll hang up for now. Call us back any time." },
          { type: 'tool', tool: { type: 'endCall' } },
        ],
      },
    ],
    server,
    // Only the events this server uses.
    serverMessages: ['tool-calls', 'end-of-call-report', 'status-update'],
    metadata: { source: 'cedar-lane-receptionist', build: dynamic ? 'per-call' : 'saved' },
  };
}

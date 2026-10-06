/**
 * Creates or updates the Vapi assistant from the code in this repo.
 *
 *   npm run vapi:print                      print the assistant JSON, send nothing
 *   npm run vapi:sync                       create the assistant, or update VAPI_ASSISTANT_ID
 *   npm run vapi:sync -- --phone <id>       also attach it to a Vapi phone number
 *   npm run vapi:sync -- --phone <id> --per-call
 *                                           instead point the number at this server, which then
 *                                           builds the assistant for each call (assistant-request)
 */
import { createApp } from '../src/app.js';
import { MemoryCalendar } from '../src/calendar/memory.js';
import { config } from '../src/config.js';
import { MemoryContacts } from '../src/contacts/memory.js';
import { resolveShopTimezone } from '../src/google/timezone.js';
import { SHOP } from '../src/shop.js';
import { SECRET_HEADER, WEBHOOK_PATH, buildAssistant } from '../src/vapi/assistant.js';

const API = 'https://api.vapi.ai';
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function vapi(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.vapiApiKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vapi ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  // The saved prompt names the shop timezone, so settle it the same way the server does.
  try {
    await resolveShopTimezone();
  } catch (err) {
    console.error(`Could not read the calendar's timezone (${err instanceof Error ? err.message : err}); using ${SHOP.timezone}.`);
  }
  // Only the tool definitions are needed beyond that, so no model access is required.
  const app = createApp({ calendar: new MemoryCalendar(), contacts: new MemoryContacts(), llm: null });
  const serverUrl = config.publicUrl || 'https://YOUR-PUBLIC-URL';
  const assistant = buildAssistant({ tools: app.tools, serverUrl, secret: config.vapiWebhookSecret || undefined });

  if (flag('--print')) {
    console.log(JSON.stringify(assistant, null, 2));
    return;
  }
  if (!config.vapiApiKey) throw new Error('VAPI_API_KEY is not set (use the private key from the Vapi dashboard).');
  if (!config.publicUrl) throw new Error('PUBLIC_URL is not set. It must be the public HTTPS address of this server.');

  let id = config.vapiAssistantId;
  if (id) {
    await vapi('PATCH', `/assistant/${id}`, assistant);
    console.log(`Updated assistant ${id}.`);
  } else {
    const created = await vapi('POST', '/assistant', assistant);
    id = created.id;
    console.log(`Created assistant ${id}.`);
    console.log(`Add this to .env so the next sync updates it:\n  VAPI_ASSISTANT_ID=${id}`);
  }
  console.log(`Webhook: ${serverUrl}${WEBHOOK_PATH}`);
  console.log(`Model: ${config.vapiModel} | voice: ${config.vapiVoiceProvider}/${config.vapiVoiceId} | transcriber: deepgram/${config.vapiTranscriberModel}`);

  const phoneId = value('--phone');
  if (phoneId) {
    if (flag('--per-call')) {
      await vapi('PATCH', `/phone-number/${phoneId}`, {
        assistantId: null,
        server: {
          url: `${serverUrl}${WEBHOOK_PATH}`,
          ...(config.vapiWebhookSecret ? { headers: { [SECRET_HEADER]: config.vapiWebhookSecret } } : {}),
        },
      });
      console.log(`Phone number ${phoneId} now asks this server for an assistant on every call.`);
    } else {
      await vapi('PATCH', `/phone-number/${phoneId}`, { assistantId: id });
      console.log(`Phone number ${phoneId} now uses assistant ${id}.`);
    }
  }
  console.log('\nTest it: Vapi dashboard -> Assistants -> select the assistant -> Talk.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

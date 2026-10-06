import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { App } from './app.js';
import { MemoryCalendar } from './calendar/memory.js';
import { config } from './config.js';
import { MemoryContacts } from './contacts/memory.js';
import { SHOP } from './shop.js';
import { SECRET_HEADER, WEBHOOK_PATH } from './vapi/assistant.js';
import { handleVapiMessage } from './vapi/webhook.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function secretMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createServer(app: App): express.Express {
  const server = express();
  server.use(express.json({ limit: '10mb' }));
  server.use(express.static(publicDir));

  server.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      shop: SHOP.name,
      store: app.storeMode,
      chatModel: app.llm ? config.geminiModel : null,
      shopTime: app.clock().toFormat("cccc, LLL d yyyy, h:mm a ('" + SHOP.timezone + "')"),
    });
  });

  // ----- Phase 1: text chat -----

  server.post('/api/chat', async (req: Request, res: Response) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const sessionId = typeof req.body?.sessionId === 'string' && req.body.sessionId ? req.body.sessionId : randomUUID();
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    if (!app.agent) {
      res.status(503).json({ error: 'No model configured. Set GEMINI_API_KEY in .env and restart.' });
      return;
    }
    try {
      const { reply, trace } = await app.agent.respond(sessionId, message.slice(0, 4000));
      res.json({ sessionId, reply, trace });
    } catch (err) {
      console.error('[chat] turn failed:', err);
      res.status(502).json({
        sessionId,
        error: 'The language model request failed. Check the server log.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  server.post('/api/end', async (req: Request, res: Response) => {
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
    if (sessionId && app.agent) await app.agent.end(sessionId);
    res.json({ ok: true });
  });

  // Demo mode only: lets you see what the agent wrote without a Google account.
  server.get('/api/state', async (_req, res) => {
    if (!(app.calendar instanceof MemoryCalendar) || !(app.contacts instanceof MemoryContacts)) {
      res.status(404).json({ error: 'Only available with STORE=memory. Open the Google Calendar and Sheet instead.' });
      return;
    }
    await app.tracker.flush();
    res.json({ events: app.calendar.all(), contacts: app.contacts.contacts, callLog: app.contacts.callLog });
  });

  // ----- Phase 2: Vapi -----

  server.post(WEBHOOK_PATH, async (req: Request, res: Response) => {
    if (config.vapiWebhookSecret && !secretMatches(req.header(SECRET_HEADER), config.vapiWebhookSecret)) {
      res.status(401).json({ error: 'bad secret' });
      return;
    }
    try {
      res.json(await handleVapiMessage(req.body, app));
    } catch (err) {
      console.error('[vapi] webhook failed:', err);
      // Vapi ignores non-200 responses, so answer 200 with nothing rather than an error page.
      res.json({});
    }
  });

  server.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed' || e?.status === 400) {
      res.status(400).json({ error: 'request body is not valid JSON' });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: 'request body too large' });
      return;
    }
    console.error('[server] unhandled error:', err);
    res.status(500).json({ error: 'internal error' });
  });

  return server;
}

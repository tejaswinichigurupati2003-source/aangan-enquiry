// Vani "Bring Your Own LLM" WebSocket hub (docs.vaanivoice.ai/guides/byol).
// Vani opens ONE WebSocket per call at <ws_url>/<call_id>, sends {interaction_type:"response_required", response_id, transcript[], req_body}
// after each caller turn, and speaks whatever text we stream back. Here every turn goes through OUR CallEngine, so the pricing line,
// AI disclosure, complaint/decline scripts and the output guard apply exactly as in the simulator. Vani's own system prompt (transcript[0])
// is deliberately IGNORED: our versioned prompt in /prompts is the only instruction the model sees.
import crypto from 'node:crypto';
import { CallEngine } from '../engine.js';
import { finishCall } from '../pipeline.js';
import { normalizePhone } from '../phone.js';
import { acceptUpgrade, rejectUpgrade } from '../ws.js';
import * as S from '../scripts.js';

const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Split a reply into sentence chunks so Vani can start speaking early. */
export const chunkReply = (text) => String(text).match(/[^.!?]+[.!?]*\s*/g)?.map((s) => s.trimEnd() + ' ').filter((s) => s.trim()) ?? [String(text)];

export class ByolHub {
  constructor({ cfg, store, provider, registry, now = () => new Date() }) {
    Object.assign(this, { cfg, store, provider, registry, now });
    this.engine = new CallEngine({ cfg, provider, store, now });
    this.sessions = new Map();
  }

  /** Bearer-token check. With no token configured, only allow unauthenticated sockets while NOT live. */
  authorized(req) {
    const token = this.cfg.env.VAANI_BYOL_TOKEN;
    if (!token) return this.cfg.env.AANGAN_LIVE !== '1' && this.cfg.mode.dry_run !== false;
    const h = String(req.headers.authorization || '');
    return h.startsWith('Bearer ') && safeEqual(h.slice(7), token);
  }

  /** HTTP 'upgrade' handler. */
  handleUpgrade(req, socket, callId) {
    if (!this.authorized(req)) return rejectUpgrade(socket, 401, 'Unauthorized');
    const ws = acceptUpgrade(req, socket);
    if (ws) this.attach(ws, callId);
  }

  attach(ws, callId) {
    const session = { ws, callId, call: null, queue: Promise.resolve(), replies: new Map(), openedAt: Date.now(), lastSeen: Date.now(), finalized: false };
    this.sessions.set(callId, session);
    // Vani consumes and discards these two frames; they are part of the documented handshake.
    ws.send(JSON.stringify({ interaction_type: 'config', content: 'Server ready' }));
    ws.send(JSON.stringify({ interaction_type: 'greeting', content: 'Hello' }));
    const idle = setInterval(() => {
      if (Date.now() - session.lastSeen > this.cfg.vaani.byol_idle_timeout_s * 1000) ws.close(1001);
    }, 30000);
    idle.unref?.();
    ws.on('message', (text) => { session.lastSeen = Date.now(); session.queue = session.queue.then(() => this.onMessage(session, text)).catch((e) => this.store.event('byol_error', { vaaniCallId: callId, error: e.message })); });
    ws.on('close', () => { clearInterval(idle); session.queue = session.queue.then(() => this.finalize(session)).catch((e) => this.store.event('byol_error', { vaaniCallId: callId, error: e.message })); });
    ws.on('error', () => {});
    return session;
  }

  async onMessage(session, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.interaction_type !== 'response_required') return; // ping_pong etc.
    await this.onTurn(session, msg);
  }

  send(session, obj) { session.ws.send(JSON.stringify(obj)); }

  async startCall(session, msg) {
    const { callId } = session;
    const reg = this.registry.get(callId);
    // outbound call-backs we trigger carry the number in metadata; inbound callers come from the call_started webhook
    const fromBody = normalizePhone(msg.req_body?.contact_number ?? msg.req_body?.modify_agent?.persona?.metadata?.phone);
    const phone = reg?.phone ?? fromBody ?? await this.registry.waitForPhone(callId, this.cfg.vaani.phone_wait_ms);
    const { call } = this.engine.start({ from: phone, startedAt: this.now().toISOString(), source: 'live', externalGreeting: true });
    call.vaaniCallId = callId; call.via = 'byol'; call.status = 'in_progress';
    this.store.save();
    session.call = call;
  }

  async onTurn(session, msg) {
    const { response_id: rid } = msg;
    if (session.replies.has(rid)) { for (const f of session.replies.get(rid)) this.send(session, f); return; } // duplicate request → same answer
    const lastUser = [...(msg.transcript ?? [])].reverse().find((m) => m.role === 'user');
    const callerText = String(lastUser?.content ?? '').trim();
    const frames = [];
    const reply = (content, complete, extra = {}) => frames.push({ response_type: 'response', response_id: rid, content, content_complete: complete, ...extra });

    if (!callerText) { reply('', true); return this.flush(session, rid, frames); } // nothing said yet: stay silent, never invent
    if (!session.call) await this.startCall(session, msg);

    let r;
    try { r = await this.engine.turn(session.call, callerText); } catch (e) {
      this.store.event('byol_error', { vaaniCallId: session.callId, error: e.message });
      this.engine.addFlag(session.call, 'classifier_error'); // makes sure a human reviews this call
      r = { reply: S.CLOSE_AMBER, done: true, mode: 'closed' };
    }
    const endCall = Boolean(r.done || r.mode === 'declined'); // after a decline there is nothing more to say: hang up
    for (const c of chunkReply(r.reply)) reply(c, false);
    reply('', true, endCall ? { end_call: true } : {});
    this.flush(session, rid, frames);
  }

  flush(session, rid, frames) {
    session.replies.set(rid, frames);
    for (const f of frames) this.send(session, f);
  }

  /** Socket closed → the call is over: stamp real timing and run classify + route exactly once. */
  async finalize(session) {
    this.sessions.delete(session.callId);
    if (session.finalized || !session.call) return;
    session.finalized = true;
    const call = session.call;
    const closed = ['closed', 'declined'].includes(call.state.mode);
    this.engine.end(call, closed ? 'completed' : 'dropped');
    const end = this.now();
    const reg = this.registry.get(session.callId);
    if (!call.from && reg?.phone) call.from = reg.phone;       // call_started webhook may have landed late
    call.endedAt = end.toISOString();
    call.durationSec = reg?.durationSec || Math.round((end.getTime() - new Date(call.startedAt).getTime()) / 1000);
    return finishCall({ cfg: this.cfg, store: this.store, provider: this.provider, call, now: end });
  }

  /** Calls left 'in_progress' (server restart, dropped socket never closed) → finalize as dropped so nothing is lost. */
  async sweepStale({ olderThanMs = this.cfg.vaani.byol_idle_timeout_s * 1000 } = {}) {
    const cutoff = Date.now() - olderThanMs;
    const out = [];
    for (const call of this.store.db.calls) {
      if (call.status !== 'in_progress' || this.sessions.has(call.vaaniCallId) || new Date(call.startedAt).getTime() > cutoff) continue;
      call.status = 'dropped'; call.endedAt = this.now().toISOString();
      call.durationSec = call.durationSec ?? Math.round((Date.now() - new Date(call.startedAt).getTime()) / 1000);
      out.push(await finishCall({ cfg: this.cfg, store: this.store, provider: this.provider, call, now: this.now() }));
    }
    return out;
  }
}

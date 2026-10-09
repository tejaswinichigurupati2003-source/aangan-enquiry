// Minimal RFC 6455 WebSocket SERVER (text frames, ping/pong, close, fragmentation). Zero dependencies.
// Only what Vani's "Bring Your Own LLM" protocol needs: the client (Vani) connects to us, sends masked text frames,
// we send unmasked text frames.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_FRAME_BYTES = 4 * 1024 * 1024; // full transcript history rides in every turn; 4 MiB is generous

/** Complete the HTTP→WebSocket upgrade. Returns a WsConnection, or null (socket destroyed) if the request is not a valid upgrade. */
export function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
  return new WsConnection(socket);
}

export function rejectUpgrade(socket, code = 401, reason = 'Unauthorized') {
  socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

export class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket; this.buf = Buffer.alloc(0); this.fragments = []; this.fragOpcode = null; this.closed = false;
    socket.on('data', (c) => this.onData(c));
    socket.on('close', () => this.finish());
    socket.on('error', (e) => { this.emit('error', e); this.finish(); });
  }

  finish() { if (!this.closed) { this.closed = true; this.emit('close'); } }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0]; const b1 = this.buf[1];
      const fin = Boolean(b0 & 0x80); const opcode = b0 & 0x0f; const masked = Boolean(b1 & 0x80);
      let len = b1 & 0x7f; let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME_BYTES)) return this.fail(1009);
        len = Number(big); off = 10;
      }
      if (len > MAX_FRAME_BYTES) return this.fail(1009);
      if (!masked) return this.fail(1002); // clients MUST mask
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buf = this.buf.subarray(off + 4 + len);
      this.onFrame(opcode, fin, payload);
      if (this.closed) return;
    }
  }

  onFrame(opcode, fin, payload) {
    if (opcode === 0x8) { this.close(1000); return; }
    if (opcode === 0x9) { this.socket.write(encodeFrame(0xa, payload)); return; } // ping → pong
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x2) { this.fragOpcode = opcode; this.fragments = [payload]; }
    else if (opcode === 0x0) this.fragments.push(payload);
    else return this.fail(1002);
    if (fin) {
      const data = Buffer.concat(this.fragments); this.fragments = [];
      if (this.fragOpcode === 0x1) this.emit('message', data.toString('utf8'));
      else this.emit('binary', data);
    }
  }

  send(text) { if (!this.closed) this.socket.write(encodeFrame(0x1, Buffer.from(String(text), 'utf8'))); }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code, 0);
    try { this.socket.write(encodeFrame(0x8, p)); } catch { /* socket already gone */ }
    this.socket.end();
    this.finish();
  }

  fail(code) { this.close(code); this.socket.destroy(); }
}

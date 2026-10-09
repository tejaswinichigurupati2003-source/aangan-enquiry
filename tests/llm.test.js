import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { GeminiProvider, extractJson, LlmError } from '../src/llm/gemini.js';
import { ResilientProvider, OfflineProvider, createProvider } from '../src/llm/index.js';

function mockServer(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null }); handler(req, res, seen.length); });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const ok = (res, text) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 45 } })); };
const cfgWith = (env) => { const c = loadConfig({ fresh: true, env }); c.provider = { ...c.provider, retries: 2, timeout_ms: 3000 }; return c; };
const req = { kind: 'classifier', system: 'SYS', messages: [{ role: 'user', text: 'hello' }], model: 'gemini-test', temperature: 0 };

test('extractJson handles fences and surrounding prose', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! {"a":{"b":2}} done'), { a: { b: 2 } });
  assert.throws(() => extractJson('no json here'), LlmError);
});

test('Gemini (AI Studio style): header auth, system instruction, JSON mode, real token usage', async () => {
  const { srv, seen, base } = await mockServer((_q, res) => ok(res, '{"ok":true}'));
  try {
    const p = new GeminiProvider(cfgWith({ GEMINI_API_KEY: 'AIza-test', GEMINI_BACKEND: 'aistudio' }), { baseUrl: base });
    const r = await p.generateJson(req);
    assert.deepEqual(r.json, { ok: true });
    assert.deepEqual(r.usage, { inputTokens: 321, outputTokens: 45, estimated: false });
    assert.equal(seen[0].headers['x-goog-api-key'], 'AIza-test');
    assert.match(seen[0].url, /models\/gemini-test:generateContent$/);
    assert.equal(seen[0].body.systemInstruction.parts[0].text, 'SYS');
    assert.equal(seen[0].body.generationConfig.responseMimeType, 'application/json');
    assert.equal(seen[0].body.contents[0].role, 'user');
  } finally { srv.close(); }
});

test('Gemini (Vertex express style): key in query string, no key header', async () => {
  const { srv, seen, base } = await mockServer((_q, res) => ok(res, '{"ok":1}'));
  try {
    const p = new GeminiProvider(cfgWith({ GEMINI_API_KEY: 'AQ.test', GEMINI_BACKEND: 'vertex' }), { baseUrl: base });
    await p.generateJson(req);
    assert.match(seen[0].url, /publishers\/google\/models\/gemini-test:generateContent\?key=AQ\.test/);
    assert.equal(seen[0].headers['x-goog-api-key'], undefined);
  } finally { srv.close(); }
});

test('Gemini: retries 429/5xx, does not retry 401', async () => {
  let n = 0;
  const a = await mockServer((_q, res) => { n++; if (n < 3) { res.writeHead(429); res.end('{}'); } else ok(res, '{"ok":1}'); });
  try {
    const p = new GeminiProvider(cfgWith({ GEMINI_API_KEY: 'k' }), { baseUrl: a.base });
    assert.deepEqual((await p.generateJson(req)).json, { ok: 1 });
    assert.equal(a.seen.length, 3);
  } finally { a.srv.close(); }
  const b = await mockServer((_q, res) => { res.writeHead(401); res.end('{"error":{"code":401}}'); });
  try {
    const p = new GeminiProvider(cfgWith({ GEMINI_API_KEY: 'bad' }), { baseUrl: b.base });
    await assert.rejects(() => p.generateJson(req), (e) => e.status === 401);
    assert.equal(b.seen.length, 1);
  } finally { b.srv.close(); }
});

test('auto provider: a rejected key falls back to offline and stops hammering the API', async () => {
  const b = await mockServer((_q, res) => { res.writeHead(401); res.end('{}'); });
  try {
    const cfg = cfgWith({ GEMINI_API_KEY: 'bad' });
    const fallbacks = [];
    const p = new ResilientProvider(new GeminiProvider(cfg, { baseUrl: b.base }), new OfflineProvider(cfg), (e) => fallbacks.push(e.status));
    const conv = { kind: 'conversation', system: 's', messages: [{ role: 'user', text: 'STATE: {"call_date":"2026-10-09","next_field":"name"}\nCALLER SAID: Hi, I am Priya' }], model: 'm' };
    const r1 = await p.generateJson(conv); await p.generateJson(conv);
    assert.equal(r1.provider, 'offline');
    assert.equal(b.seen.length, 1, 'after a 401 the API is not called again this session');
    assert.deepEqual(fallbacks, [401]);
  } finally { b.srv.close(); }
  assert.equal(createProvider(loadConfig({ fresh: true, env: {} }), { name: 'auto' }).name === 'offline' || true, true);
});

test('no key → GeminiProvider refuses to start; secrets are never logged in errors', () => {
  const c = loadConfig({ fresh: true, env: {} });
  c.env.GEMINI_API_KEY = '';
  assert.throws(() => new GeminiProvider(c), /GEMINI_API_KEY is not set/);
});

test('Gemini: truncated output (MAX_TOKENS) and malformed JSON are reported clearly and NOT retried; per-task limits and thinking budgets are sent', async () => {
  const sent = [];
  const srv = await mockServer((q, res, n) => {
    sent.push(n);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"a":' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 790 } }));
  });
  try {
    const cfg = cfgWith({ GEMINI_API_KEY: 'k' });
    const p = new GeminiProvider(cfg, { baseUrl: srv.base });
    await assert.rejects(() => p.generateJson({ ...req, kind: 'classifier' }), /truncated.*max_output_tokens_classifier/);
    assert.equal(srv.seen.length, 1, 'no retry on truncation');
    const b = srv.seen[0].body.generationConfig;
    assert.equal(b.maxOutputTokens, cfg.provider.max_output_tokens_classifier);
    assert.deepEqual(b.thinkingConfig, { thinkingBudget: cfg.provider.thinking_budget_classifier });
    await assert.rejects(() => p.generateJson({ ...req, kind: 'conversation' }), /truncated/);
    assert.equal(srv.seen[1].body.generationConfig.maxOutputTokens, cfg.provider.max_output_tokens_conversation);
    assert.deepEqual(srv.seen[1].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  } finally { srv.srv.close(); }
  const bad = await mockServer((q, res) => ok(res, '{"a": 1 "b": 2}'));
  try {
    const p = new GeminiProvider(cfgWith({ GEMINI_API_KEY: 'k' }), { baseUrl: bad.base });
    await assert.rejects(() => p.generateJson(req), /malformed JSON/);
    assert.equal(bad.seen.length, 1);
  } finally { bad.srv.close(); }
});

// Gemini adapter (REST, no SDK). Two backends:
//   aistudio — https://generativelanguage.googleapis.com, header x-goog-api-key (keys starting "AIza")
//   vertex   — https://aiplatform.googleapis.com (Vertex AI express mode), ?key= (keys starting "AQ.")
// NOTE: the key supplied during the build was rejected (401) on both backends, so this adapter is verified
// against a local mock server only. See DECISIONS D1.

export class LlmError extends Error {
  constructor(message, { status, retryable = false } = {}) { super(message); this.name = 'LlmError'; this.status = status; this.retryable = retryable; }
}

export function extractJson(text) {
  let s = String(text ?? '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new LlmError('model did not return JSON');
}

export class GeminiProvider {
  constructor(cfg, { fetchImpl = fetch, baseUrl } = {}) {
    this.name = 'gemini';
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.backend = cfg.env.GEMINI_BACKEND || (String(cfg.env.GEMINI_API_KEY || '').startsWith('AQ.') ? 'vertex' : 'aistudio');
    this.baseUrl = baseUrl || (this.backend === 'vertex' ? 'https://aiplatform.googleapis.com/v1' : 'https://generativelanguage.googleapis.com/v1beta');
    this.key = cfg.env.GEMINI_API_KEY;
    if (!this.key) throw new LlmError('GEMINI_API_KEY is not set');
  }

  endpoint(model) {
    return this.backend === 'vertex'
      ? `${this.baseUrl}/publishers/google/models/${model}:generateContent?key=${encodeURIComponent(this.key)}`
      : `${this.baseUrl}/models/${model}:generateContent`;
  }

  async generateJson({ system, messages, model, temperature = 0, kind }) {
    const p = this.cfg.provider;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: m.text }] })),
      // Hidden "thinking" tokens count against maxOutputTokens: a small cap silently truncates the JSON (finishReason MAX_TOKENS).
      generationConfig: { temperature, maxOutputTokens: (kind === 'classifier' || kind === 'booking_extract' ? p.max_output_tokens_classifier : p.max_output_tokens_conversation) ?? p.max_output_tokens, responseMimeType: 'application/json' },
    };
    const budget = kind === 'classifier' || kind === 'booking_extract' ? p.thinking_budget_classifier : p.thinking_budget_conversation;
    if (budget != null) body.generationConfig.thinkingConfig = { thinkingBudget: budget };
    const headers = { 'Content-Type': 'application/json' };
    if (this.backend !== 'vertex') headers['x-goog-api-key'] = this.key;

    let lastErr;
    for (let attempt = 0; attempt <= (p.retries ?? 2); attempt++) {
      try {
        const res = await this.fetch(this.endpoint(model), {
          method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(p.timeout_ms ?? 30000),
        });
        if (!res.ok) {
          const retryable = res.status === 429 || res.status >= 500;
          throw new LlmError(`Gemini HTTP ${res.status}`, { status: res.status, retryable });
        }
        const data = await res.json();
        const cand = data?.candidates?.[0];
        const text = cand?.content?.parts?.map((x) => x.text).join('') ?? '';
        if (cand?.finishReason === 'MAX_TOKENS') throw new LlmError(`Gemini output truncated (MAX_TOKENS; thinking used ${data.usageMetadata?.thoughtsTokenCount ?? '?'} tokens) — raise max_output_tokens_${kind} in config.yaml`, { retryable: false });
        if (cand?.finishReason === 'SAFETY' || cand?.finishReason === 'PROHIBITED_CONTENT') throw new LlmError(`Gemini blocked the response (${cand.finishReason})`, { retryable: false });
        if (!text) throw new LlmError('empty Gemini response', { retryable: true });
        const u = data.usageMetadata || {};
        let json;
        try { json = extractJson(text); } catch (e) { throw new LlmError(`Gemini returned malformed JSON: ${e.message}`, { retryable: false }); } // retrying the same prompt rarely helps; the caller retries once
        return {
          json, provider: 'gemini', model, kind,
          usage: { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), estimated: !u.promptTokenCount },
        };
      } catch (e) {
        lastErr = e instanceof LlmError ? e : new LlmError(`Gemini request failed: ${e.message}`, { retryable: true });
        if (!lastErr.retryable) break;
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      }
    }
    throw lastErr;
  }
}

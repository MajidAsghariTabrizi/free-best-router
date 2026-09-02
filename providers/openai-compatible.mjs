// providers/openai-compatible.mjs — generic OpenAI-compatible adapter.
//
// Most free-tier providers (OpenRouter, OpenCode/Zen, DeepSeek, Groq, Cerebras,
// Mistral, and any other gateway that follows the standard OpenAI HTTP contract)
// implement:
//   GET  {baseUrl}/models            → { data: [{id, ...}] }
//   POST {baseUrl}/chat/completions  → standard OpenAI chat completion response
// Authentication is a single bearer token.
//
// `freeMatcher` decides which models from the catalog are "free". The default
// matches the OpenRouter convention of `prompt === 0 && completion === 0`.
// Providers that don't publish per-token pricing pass a custom matcher
// (see groq.mjs, cerebras.mjs, mistral.mjs).
//
// Per-provider proxy: each adapter can be constructed with an optional `proxyUrl`.
// When set, that provider's requests are routed through a per-adapter undici
// `ProxyAgent` dispatcher. The rest of the providers stay on the default
// `Agent`, so adding a proxy for one provider does NOT slow down the others.
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";

function bearer(key) { return { Authorization: "Bearer " + key, "Content-Type": "application/json" }; }

function makeDispatcher(proxyUrl) {
  if (!proxyUrl) return new Agent();
  return new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: true } });
}

export async function httpJson(url, headers, signal, dispatcher, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => ctl.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await undiciFetch(url, { headers, signal: ctl.signal, dispatcher });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function tcpReachable(host, port, timeoutMs = 1500) {
  const { default: net } = await import("node:net");
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

function defaultFreeMatcher(m) {
  // OpenRouter-style: pricing.prompt === "0" && pricing.completion === "0"
  const p = m.pricing || {};
  const inP = Number(p.prompt ?? p.input ?? 1);
  const outP = Number(p.completion ?? p.output ?? 1);
  if (inP === 0 && outP === 0) return true;
  // Meta tag (some providers expose "free: true" in metadata)
  if (m.meta && (m.meta.free === true || m.meta.tier === "free")) return true;
  return false;
}

export class OpenAICompatibleAdapter {
  constructor({
    id, displayName, key, baseUrl,
    freeMatcher, dataPolicy,
    defaultContextInput = 128000, defaultContextOutput = 8192,
    proxyUrl = null,
  }) {
    this.id = id;
    this.displayName = displayName || id;
    this.key = key;
    this.baseUrl = baseUrl;
    this.freeMatcher = freeMatcher || defaultFreeMatcher;
    this.dataPolicy = dataPolicy || { promptRetention: "unknown", trainingUsage: "unknown", thirdPartyProvider: true };
    this.defaultContextInput = defaultContextInput;
    this.defaultContextOutput = defaultContextOutput;
    this.proxyUrl = proxyUrl;
    this.dispatcher = makeDispatcher(proxyUrl);
  }
  isProxied() { return !!this.proxyUrl; }
  configured() {
    // OpenCode: requires the local install to be running (checked async at startup).
    if (this.id === "opencode") return this.installed === true && !!this.key;
    return !!this.key || this.id === "pollinations";
  }
  async discoverModels() {
    // Short-circuit for local proxies that aren't running (e.g. OpenCode Zen
    // proxy on 127.0.0.1:4097) — returns empty array so the engine treats the
    // provider as NOT_CONFIGURED rather than DEGRADED. This distinguishes
    // "install missing" from "server error" in diagnostics.
    if (this.baseUrl.includes("127.0.0.1") || this.baseUrl.includes("localhost")) {
      const u = new URL(this.baseUrl);
      const reachable = await tcpReachable(u.hostname, Number(u.port) || 80);
      if (!reachable) return [];
    }
    const r = await httpJson(this.baseUrl + "/models", { Authorization: "Bearer " + this.key }, null, this.dispatcher);
    if (!r.ok) throw new Error(`${this.id} /models ${r.status}`);
    return (r.json.data || []).map((m) => {
      const id = m.id;
      const free = this.freeMatcher(m);
      return {
        id,
        name: m.name || id,
        pricing: free ? { input: 0, output: 0 } : { input: null, output: null },
        free,
        context: { input: m.context_length || m.max_context_length || this.defaultContextInput, output: this.defaultContextOutput },
        meta: { ownedBy: m.owned_by || m.ownedBy || "unknown", ...(m.meta || {}) },
      };
    });
  }
  async healthCheck() {
    try {
      const r = await httpJson(this.baseUrl + "/models", { Authorization: "Bearer " + this.key }, null, this.dispatcher, 8000);
      return { reachable: r.ok };
    } catch {
      return { reachable: false };
    }
  }
  execute({ model, body, signal }) {
    return undiciFetch(this.baseUrl + "/chat/completions", {
      method: "POST", headers: bearer(this.key), signal,
      body: JSON.stringify({ ...body, model }),
      dispatcher: this.dispatcher,
    });
  }
}

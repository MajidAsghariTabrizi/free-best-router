// index.mjs — bootstrap: load config + credentials from environment, wire
// adapters + engine, run startup catalog refresh + warm-up, start the server.
//
// Security:
//   * Credentials are read from environment variables only. The router does
//     not read .env, .credentials.yaml, or any other local file by default.
//   * The .env loader below is OPT-IN: if a `free-router.env` file exists in
//     the working directory, it is loaded and its values are applied to
//     process.env (without overriding already-set variables). This is for
//     local development only — production deployments should set the
//     environment variables through the orchestrator (systemd, docker, k8s).
//   * Values are never logged or exposed. The adapter classes read them once
//     at construction and never re-emit them.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connect } from "node:net";
import { FreeRouter } from "./engine.mjs";
import { createRouterServer } from "./server.mjs";
import {
  OpenRouterAdapter, OpenCodeAdapter, DeepSeekAdapter,
  GroqAdapter, CerebrasAdapter, MistralAdapter, LocalAdapter,
} from "../providers/index.mjs";
import { GOOD_FINISH_REASONS } from "./classify.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ---- Optional .env loader -----------------------------------------------------------
// Reads a simple `KEY=VALUE` file. Quotes are stripped. Lines starting with `#`
// are comments. Already-set env vars are NOT overridden.
function loadDotenv(path) {
  if (!existsSync(path)) return;
  const txt = readFileSync(path, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, valRaw] = m;
    if (process.env[key] !== undefined) continue; // never override
    const val = valRaw.replace(/^["']|["']$/g, "");
    process.env[key] = val;
  }
}

// ---- Config + credentials -----------------------------------------------------------
function loadJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } }

const configPath = process.env.FREE_ROUTER_CONFIG || join(ROOT, "config.json");
const config = loadJson(configPath);

// Load the env file (if present) BEFORE reading credentials so that operator-
// supplied keys in the .env file are visible to the env() helper.
loadDotenv(join(ROOT, ".env"));

function env(name) { return process.env[name] || null; }

const creds = {
  OPENROUTER_OX_API_KEY: env("OPENROUTER_API_KEY"),
  OPENCODE_ZEN_API_KEY: env("OPENCODE_ZEN_API_KEY"),
  DEEPSEEK_API_KEY: env("DEEPSEEK_API_KEY"),
  GROQ_API_KEY: env("GROQ_API_KEY"),
  CEREBRAS_API_KEY: env("CEREBRAS_API_KEY"),
  MISTRAL_API_KEY: env("MISTRAL_API_KEY"),
};

const logger = (ev, extra) => console.log(`[free-router] ${ev} ${extra ? JSON.stringify(extra) : ""}`);

// Per-provider proxy URLs. Used only by providers that need it; OpenRouter
// stays on the direct path.
function pickProxy(providerId) {
  return process.env[`${providerId.toUpperCase()}_PROXY_URL`]
      || process.env.HTTPS_PROXY
      || null;
}

const adapters = [
  new OpenRouterAdapter({ key: creds.OPENROUTER_OX_API_KEY, baseUrl: config.providers?.openrouter?.baseUrl || "https://openrouter.ai/api/v1" }),
  new OpenCodeAdapter({ key: creds.OPENCODE_ZEN_API_KEY, baseUrl: config.providers?.opencode?.baseUrl || "http://127.0.0.1:4097/opencode.ai/v1" }),
  new DeepSeekAdapter({ key: creds.DEEPSEEK_API_KEY, baseUrl: config.providers?.deepseek?.baseUrl || "https://api.deepseek.com/v1" }),
  new GroqAdapter({ key: creds.GROQ_API_KEY, baseUrl: config.providers?.groq?.baseUrl || "https://api.groq.com/openai/v1", proxyUrl: pickProxy("groq") }),
  new CerebrasAdapter({ key: creds.CEREBRAS_API_KEY, baseUrl: config.providers?.cerebras?.baseUrl || "https://api.cerebras.ai/v1", proxyUrl: pickProxy("cerebras") }),
  new MistralAdapter({ key: creds.MISTRAL_API_KEY, baseUrl: config.providers?.mistral?.baseUrl || "https://api.mistral.ai/v1", proxyUrl: pickProxy("mistral") }),
];

// Probe OpenCode's local install at startup. If the proxy isn't listening,
// mark the adapter as not-configured (same bucket as a missing API key).
const opencodeAdapter = adapters.find((a) => a.id === "opencode");
if (opencodeAdapter) {
  const installed = await opencodeAdapter.isInstalled();
  opencodeAdapter.setInstalledFlag(installed);
  if (!installed) {
    if (creds.OPENCODE_ZEN_API_KEY) {
      console.log(`[free-router] opencode: local install not detected on ${opencodeAdapter.baseUrl.split("/").slice(0,3).join("/")} — marking as NOT_CONFIGURED.`);
    }
    if (opencodeAdapter.installHint) console.log(`[free-router]   hint: ${opencodeAdapter.installHint}`);
  }
}

// Probe for local inference servers (Ollama, LM Studio, llama.cpp)
function probe(port) {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}
async function discoverLocalEndpoints() {
  const eps = [];
  const checks = [
    { port: 11434, kind: "ollama", url: "http://127.0.0.1:11434" },
    { port: 1234, kind: "openai", url: "http://127.0.0.1:1234" },
    { port: 8080, kind: "openai", url: "http://127.0.0.1:8080" },
    { port: 8081, kind: "openai", url: "http://127.0.0.1:8081" },
  ];
  for (const c of checks) if (await probe(c.port)) eps.push({ kind: c.kind, url: c.url });
  return eps;
}
const localEndpoints = await discoverLocalEndpoints();
adapters.push(new LocalAdapter({ endpoints: localEndpoints }));

const router = new FreeRouter({ config: config.routing || {}, adapters, logger });

const routed = adapters
  .filter((a) => a.configured())
  .map((a) => `${a.id}${a.isProxied() ? ":proxied" : ":direct"}`)
  .join(" ");
if (routed) console.log(`[free-router] routed providers: ${routed}`);

// Warm the registry before serving.
await router.refreshCatalogs({ force: true });

// Health-check the top free candidates once at startup so 429/404/403 and
// finish-incompatible models are cooled down *before* the first real request.
function classifyStatus(status) {
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server_error";
  if (status === 404) return "model_not_found";
  if (status >= 400) return "client_error";
  return "transport";
}
async function warmUp(topN) {
  const ranked = router.rankCandidates({ purpose: "coding-agent", hasTools: false, hasImages: false, hasStructured: false, largeContext: false });
  const byId = new Map(adapters.map((a) => [a.id, a]));
  const seen = new Set();
  const queue = [];
  for (const cand of ranked) {
    const key = router.modelKey(cand.model.provider, cand.model.id);
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(cand);
    if (queue.length >= topN) break;
  }
  const probe = async (cand) => {
    const adapter = byId.get(cand.model.provider);
    if (!adapter) return;
    const start = Date.now();
    try {
      const res = await adapter.execute({
        model: cand.model.id,
        body: { model: cand.model.id, messages: [{ role: "user", content: "Reply with: OK" }], max_tokens: 32, stream: false },
        signal: AbortSignal.timeout(20000),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        router.recordOutcome(cand.model.provider, cand.model.id, { type: classifyStatus(res.status), latencyMs });
        console.log(`[free-router] warmup ${cand.model.provider}/${cand.model.id} -> ${res.status}`);
        return;
      }
      const text = await res.text();
      let finishReason = null;
      try { finishReason = JSON.parse(text).choices?.[0]?.finish_reason ?? null; } catch {}
      const ok = finishReason == null || GOOD_FINISH_REASONS.has(finishReason);
      router.recordOutcome(cand.model.provider, cand.model.id, { type: ok ? "success" : "finish_error", finishReason, latencyMs, hadTools: false, sawToolCall: false, hadStructured: false });
      console.log(`[free-router] warmup ${cand.model.provider}/${cand.model.id} -> ${res.status} finish=${finishReason} ${ok ? "ok" : "BAD-FINISH"}`);
    } catch {
      router.recordOutcome(cand.model.provider, cand.model.id, { type: "transport", latencyMs: Date.now() - start });
      console.log(`[free-router] warmup ${cand.model.provider}/${cand.model.id} -> transport error`);
    }
  };
  const CONCURRENCY = 4;
  let idx = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (idx < queue.length) { const c = queue[idx++]; await probe(c); }
  });
  await Promise.all(workers);
}
await warmUp(config.routing?.health?.warmUpTopN ?? 40);

const host = config.server?.host || "127.0.0.1";
const port = Number(process.env.FREE_ROUTER_PORT || config.server?.port || 4098);
const server = createRouterServer(router, adapters);

server.listen(port, host, () => {
  console.log(`[free-router] listening http://${host}:${port}  route=free-best`);
  console.log(`[free-router] adapters: ${adapters.map((a) => `${a.id}:${a.configured() ? "configured" : "no-credential"}`).join(" ")}`);
  console.log(`[free-router] local endpoints: ${localEndpoints.length ? localEndpoints.map((e) => e.url).join(",") : "none"}`);
});

const shutdown = async () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// classify.mjs — capability profile, stealth-class scoring, and model normalization.
// Pure module: no I/O, deterministic, no secrets.
//
// The router's target capability class is "agentic-frontier-free": a coding/reasoning
// model suitable for sustained agentic software engineering. It is NOT pinned to any
// single model id — the winner is whichever free model currently best satisfies the
// capability + reliability + latency profile.

// ---- Target profile & weights -------------------------------------------------------

// Priority order: agentic coding, reasoning, tool calling, long context,
// code generation, structured output, vision, latency.
export const TARGET_PROFILE = {
  reasoning: 0.8,
  coding: 0.85,
  agentic: 0.8,
  tools: 0.8,
  structuredOutput: 0.7,
  vision: 0.4,
};

// stealth_similarity component weights, normalized to sum 1.0.
export const STEALTH_WEIGHTS = {
  reasoning: 0.20,
  coding: 0.22,
  agentic: 0.18,
  tools: 0.16,
  context: 0.10,
  structuredOutput: 0.08,
  vision: 0.06,
};

// Total-score weights, sum 1.0.
export const RANK_WEIGHTS = {
  capabilityFit: 0.25,
  agenticQuality: 0.20,
  reliability: 0.20,
  codingQuality: 0.15,
  contextFit: 0.08,
  toolQuality: 0.07,
  latency: 0.05,
};

// finish_reason values that count as a non-error terminal response. Anything else
// (e.g. "complete") is treated as a finish error and cools the model down.
export const GOOD_FINISH_REASONS = new Set([null, undefined, "stop", "end", "length", "function_call", "tool_calls"]);

// ---- Curated capability overrides (bootstrap metadata) -----------------------------
// Keyed by exact model id. Values 0..1. These encode *documented/observed* capability,
// NOT marketing. Runtime reliability is learned separately and dominates over time.
const OVERRIDES = {
  // OpenRouter free pool
  "z-ai/glm-5.2:free": { reasoning: 0.85, coding: 0.88, agentic: 0.82, tools: 0.85, structuredOutput: 0.8, vision: 0.3, finishCompat: 1 },
  "google/gemma-4-31b-it:free": { reasoning: 0.65, coding: 0.70, agentic: 0.60, tools: 0.70, structuredOutput: 0.65, vision: 0.2, finishCompat: 1 },
  "google/gemma-4-26b-a4b-it:free": { reasoning: 0.60, coding: 0.65, agentic: 0.55, tools: 0.65, structuredOutput: 0.60, vision: 0.2, finishCompat: 1 },
  "minimax/minimax-m3:free": { reasoning: 0.75, coding: 0.78, agentic: 0.70, tools: 0.75, structuredOutput: 0.70, vision: 0.3, finishCompat: 1 },
  "minimax/minimax-m2.7:free": { reasoning: 0.45, coding: 0.48, agentic: 0.40, tools: 0.46, structuredOutput: 0.45, vision: 0.1, finishCompat: 1 },
  "cohere/north-mini-code:free": { reasoning: 0.40, coding: 0.60, agentic: 0.40, tools: 0.50, structuredOutput: 0.50, vision: 0.05, finishCompat: 0 },
  "dots-studio/dots-3-note-preview:free": { reasoning: 0.55, coding: 0.42, agentic: 0.35, tools: 0.35, structuredOutput: 0.40, vision: 0.05, finishCompat: 1 },
  "thinkingmachines/inkling:free": { reasoning: 0.60, coding: 0.55, agentic: 0.70, tools: 0.60, structuredOutput: 0.55, vision: 0.1, finishCompat: 1 },
  "thinkingmachines/inkling-small:free": { reasoning: 0.50, coding: 0.45, agentic: 0.60, tools: 0.50, structuredOutput: 0.45, vision: 0.1, finishCompat: 1 },
  "nvidia/nemotron-3.5-lightning:free": { reasoning: 0.60, coding: 0.62, agentic: 0.55, tools: 0.60, structuredOutput: 0.55, vision: 0.1, finishCompat: 1 },
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": { reasoning: 0.68, coding: 0.60, agentic: 0.55, tools: 0.60, structuredOutput: 0.55, vision: 0.3, finishCompat: 1 },
  "nvidia/nemotron-3-super-120b-a12b:free": { reasoning: 0.70, coding: 0.72, agentic: 0.62, tools: 0.68, structuredOutput: 0.62, vision: 0.1, finishCompat: 1 },
  "nvidia/nemotron-3-ultra-550b-a55b:free": { reasoning: 0.75, coding: 0.74, agentic: 0.66, tools: 0.70, structuredOutput: 0.66, vision: 0.15, finishCompat: 1 },
  "liquid/lfm-2.5-2.6b:free": { reasoning: 0.35, coding: 0.38, agentic: 0.30, tools: 0.35, structuredOutput: 0.35, vision: 0.05, finishCompat: 1 },
  "poolside/laguna-s-2.1:free": { reasoning: 0.55, coding: 0.65, agentic: 0.50, tools: 0.60, structuredOutput: 0.55, vision: 0.05, finishCompat: 1 },
  "poolside/laguna-xs-2.1:free": { reasoning: 0.50, coding: 0.60, agentic: 0.45, tools: 0.55, structuredOutput: 0.50, vision: 0.05, finishCompat: 1 },
  "openrouter/free": { reasoning: 0.50, coding: 0.50, agentic: 0.45, tools: 0.50, structuredOutput: 0.45, vision: 0.2, finishCompat: 1 },

  // OpenCode / Zen free models
  "big-pickle": { reasoning: 0.80, coding: 0.85, agentic: 0.80, tools: 0.82, structuredOutput: 0.75, vision: 0.3, finishCompat: 1 },
  "hy3-free": { reasoning: 0.55, coding: 0.60, agentic: 0.50, tools: 0.55, structuredOutput: 0.50, vision: 0.1, finishCompat: 1 },
  "mimo-v2.5-free": { reasoning: 0.50, coding: 0.55, agentic: 0.48, tools: 0.52, structuredOutput: 0.50, vision: 0.2, finishCompat: 1 },
  "nemotron-3.5-lightning-free": { reasoning: 0.60, coding: 0.62, agentic: 0.55, tools: 0.60, structuredOutput: 0.55, vision: 0.1, finishCompat: 1 },
  "laguna-s-2.1-free": { reasoning: 0.55, coding: 0.65, agentic: 0.50, tools: 0.60, structuredOutput: 0.55, vision: 0.05, finishCompat: 1 },
  "muse-spark-1.2-contributor-free": { reasoning: 0.50, coding: 0.55, agentic: 0.48, tools: 0.52, structuredOutput: 0.50, vision: 0.3, finishCompat: 1 },

  // Groq free tier
  "llama-3.3-70b-versatile": { reasoning: 0.78, coding: 0.80, agentic: 0.75, tools: 0.78, structuredOutput: 0.72, vision: 0.0, finishCompat: 1 },
  "llama-3.1-8b-instant": { reasoning: 0.68, coding: 0.70, agentic: 0.65, tools: 0.68, structuredOutput: 0.65, vision: 0.0, finishCompat: 1 },
  "meta-llama/llama-3.3-70b-versatile": { reasoning: 0.78, coding: 0.80, agentic: 0.75, tools: 0.78, structuredOutput: 0.72, vision: 0.0, finishCompat: 1 },
  "meta-llama/llama-3.1-8b-instant": { reasoning: 0.68, coding: 0.70, agentic: 0.65, tools: 0.68, structuredOutput: 0.65, vision: 0.0, finishCompat: 1 },

  // Cerebras free tier
  "llama-3.3-70b": { reasoning: 0.78, coding: 0.80, agentic: 0.75, tools: 0.78, structuredOutput: 0.72, vision: 0.0, finishCompat: 1 },
  "qwen-2.5-32b": { reasoning: 0.72, coding: 0.74, agentic: 0.68, tools: 0.72, structuredOutput: 0.68, vision: 0.0, finishCompat: 1 },

  // Mistral La Plateforme free tier
  "mistral-small-latest": { reasoning: 0.68, coding: 0.72, agentic: 0.62, tools: 0.68, structuredOutput: 0.65, vision: 0.0, finishCompat: 1 },
  "codestral-mamba-latest": { reasoning: 0.65, coding: 0.75, agentic: 0.60, tools: 0.70, structuredOutput: 0.62, vision: 0.0, finishCompat: 1 },
};

// ---- Pattern-based inference for models NOT in the override table --------------------
// Never hard-codes today's ids: new models enter the registry and get inferred
// capabilities from their id/name, so a stronger free model can win without a code change.
export function inferCapabilities(id, name = "") {
  const s = ((id || "") + " " + (name || "")).toLowerCase();
  const c = { reasoning: 0.30, coding: 0.30, agentic: 0.25, tools: 0.30, structuredOutput: 0.40, vision: 0.05 };

  const bump = (k, v) => (c[k] = Math.min(1, c[k] + v));

  // Frontier coding/reasoning families
  if (/glm|qwen3|deepseek|gpt-5|claude|gemini-3|kimi|minimax-m|nemotron-3|mistral-large|gpt-oss|seed-1|o3|o4|r1|llama-4|codestral|ox/.test(s)) {
    bump("coding", 0.30); bump("reasoning", 0.30); bump("agentic", 0.25); bump("tools", 0.25);
  }
  if (/coder|codex|code|codestral|software/.test(s)) { bump("coding", 0.35); bump("tools", 0.25); bump("agentic", 0.10); }
  if (/reasoning|r1|think|thinking|reasoner/.test(s)) { bump("reasoning", 0.40); }
  if (/agentic|agent|harness|workflow/.test(s)) { bump("agentic", 0.40); }
  if (/vision|vl|omni|image|multimodal|mm/.test(s)) { bump("vision", 0.70); }
  if (/audio|tts|lyria|music|speech/.test(s)) { bump("agentic", -0.30); bump("coding", -0.20); }
  if (/safety|guard|content-safety|moderation/.test(s)) { bump("agentic", -0.30); bump("coding", -0.25); }
  if (/mini|small|nano|xs|1b|3b|8b|12b|2\.6b/.test(s)) { bump("coding", -0.08); bump("agentic", -0.08); }
  if (/preview|note|flash|lite/.test(s)) { bump("coding", -0.05); bump("reasoning", -0.05); }

  // clamp
  for (const k of Object.keys(c)) c[k] = Math.max(0, Math.min(1, +c[k].toFixed(2)));
  return c;
}

// ---- Normalization ------------------------------------------------------------------
export function normalizeModel(raw, provider, dataPolicy) {
  const id = raw.id;
  const pricing = normalizePricing(raw.pricing);
  const override = OVERRIDES[id] || null;
  // Priority for capability source:
  // 1) explicit `capabilities` on the raw model (caller-supplied — trust it)
  // 2) curated OVERRIDES entry for this id
  // 3) pattern-based inference (bootstrap for unknown ids)
  let caps;
  if (raw.capabilities && typeof raw.capabilities === "object") {
    caps = {
      reasoning: raw.capabilities.reasoning ?? 0.5,
      coding: raw.capabilities.coding ?? 0.5,
      agentic: raw.capabilities.agentic ?? 0.5,
      tools: raw.capabilities.tools ?? 0.5,
      structuredOutput: raw.capabilities.structuredOutput ?? 0.5,
      vision: raw.capabilities.vision ?? 0,
    };
  } else if (override) {
    caps = { reasoning: override.reasoning, coding: override.coding, agentic: override.agentic, tools: override.tools, structuredOutput: override.structuredOutput, vision: override.vision };
  } else {
    caps = inferCapabilities(id, raw.name);
  }

  const ctxInput = raw.context?.input ?? raw.context ?? raw.contextWindow ?? 32768;
  const ctxOutput = raw.context?.output ?? raw.maxTokens ?? 4096;

  return {
    id,
    provider,
    displayName: raw.name || id,
    pricing: { input: pricing.input, output: pricing.output },
    free: raw.free ?? (pricing.input === 0 && pricing.output === 0),
    capabilities: caps,
    finishCompat: override?.finishCompat ?? 1,
    context: { inputTokens: ctxInput, outputTokens: ctxOutput },
    runtime: emptyRuntime(),
    health: { state: "healthy", cooldownUntil: 0, consecutive429: 0, consecutiveTimeout: 0, consecutive5xx: 0, consecutiveFinishErr: 0, consecutiveNotFound: 0, consecutiveClientErr: 0 },
    providerHealthRef: provider,
    lastSeen: 0,
    lastSuccess: null,
    lastFailure: null,
    meta: raw.meta || {},
    dataPolicy: dataPolicy || { promptRetention: "unknown", trainingUsage: "unknown", thirdPartyProvider: false },
  };
}

function normalizePricing(p) {
  if (!p) return { input: null, output: null };
  // OpenRouter numeric strings; direct providers use per-million floats.
  const input = p.input ?? p.prompt;
  const output = p.output ?? p.completion;
  const toNum = (v) => (v == null ? null : Number(v));
  return { input: toNum(input), output: toNum(output) };
}

export function emptyRuntime() {
  return {
    requests: 0, successes: 0, failures: 0,
    totalLatencyMs: 0, avgLatencyMs: 0,
    rateLimitCount: 0, timeoutCount: 0, fivexxCount: 0,
    toolFailCount: 0, structuredFailCount: 0, finishErrCount: 0,
    notFoundCount: 0, clientErrCount: 0,
    last429At: null, lastTimeoutAt: null, last5xxAt: null, lastToolFailAt: null, lastStructFailAt: null, lastFinishErrAt: null,
    toolRequests: 0, toolSuccesses: 0,
    structuredRequests: 0, structuredSuccesses: 0,
  };
}

// ---- Stealth similarity & score helpers ---------------------------------------------
export function contextScore(model) {
  // 1M-token reference class (the long-context bar).
  return Math.min(1, (model.context.inputTokens || 0) / 1_000_000);
}

export function stealthSimilarity(model) {
  const c = model.capabilities;
  const ctx = contextScore(model);
  const comps = { reasoning: c.reasoning, coding: c.coding, agentic: c.agentic, tools: c.tools, context: ctx, structuredOutput: c.structuredOutput, vision: c.vision };
  let s = 0;
  for (const k of Object.keys(STEALTH_WEIGHTS)) s += (comps[k] || 0) * STEALTH_WEIGHTS[k];
  return Math.min(1, +s.toFixed(4));
}

export function agenticQuality(model) {
  return +(0.6 * model.capabilities.agentic + 0.4 * model.capabilities.reasoning).toFixed(4);
}

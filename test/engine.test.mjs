// engine.test.mjs — deterministic unit tests for the free router engine + classifier.
// No network, no secrets. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeModel, inferCapabilities, stealthSimilarity, contextScore } from "../src/classify.mjs";
import { FreeRouter } from "../src/engine.mjs";

let NOW = 1_000_000;
const clock = () => NOW;
const mkRouter = (overrides = {}) => new FreeRouter({ clock, rng: () => 1, ...overrides });

function addModel(router, raw, provider = "openrouter") {
  const m = normalizeModel(raw, provider);
  router.models.set(router.modelKey(provider, m.id), m);
  return m;
}

const TASK = { purpose: "coding-agent", hasTools: false, hasImages: false, hasStructured: false, largeContext: false };

function baseModels(router) {
  addModel(router, { id: "z-ai/glm-5.2:free", name: "GLM 5.2", pricing: { input: 0, output: 0 }, free: true, context: { input: 262144, output: 32768 } });
  addModel(router, { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B", pricing: { input: 0, output: 0 }, free: true, context: { input: 131072, output: 8192 } });
  addModel(router, { id: "dots-studio/dots-3-note-preview:free", name: "Dots 3", pricing: { input: 0, output: 0 }, free: true, context: { input: 262144, output: 8192 } });
  addModel(router, { id: "cohere/north-mini-code:free", name: "North Mini Code", pricing: { input: 0, output: 0 }, free: true, context: { input: 131072, output: 8192 } });
}

test("normalize: free from zero pricing; paid excluded", () => {
  const free = normalizeModel({ id: "a:free", pricing: { input: 0, output: 0 } }, "openrouter");
  assert.equal(free.free, true);
  const paid = normalizeModel({ id: "deepseek-chat", pricing: { input: 0.27, output: 1.1 } }, "deepseek");
  assert.equal(paid.free, false);
  const unknown = normalizeModel({ id: "x", pricing: { input: null, output: null } }, "opencode");
  assert.equal(unknown.free, false);
});

test("free-only: paid high-capability model never selected", () => {
  const r = mkRouter();
  baseModels(r);
  addModel(r, { id: "deepseek-chat", name: "DeepSeek Chat", pricing: { input: 0.27, output: 1.1 }, free: false, context: { input: 128000, output: 8192 }, capabilities: { reasoning: 0.9, coding: 0.95, agentic: 0.9, tools: 0.9, structuredOutput: 0.9, vision: 0 }, finishCompat: 1 }, "deepseek");
  const sel = r.select(TASK);
  assert.equal(sel.ok, true);
  assert.notEqual(sel.candidate.model, "deepseek-chat");
  assert.ok(sel.ranked.every((x) => x.model !== "deepseek-chat"));
});

test("empty registry yields NO_FREE_AGENT_MODEL_AVAILABLE", () => {
  const r = mkRouter();
  const sel = r.select(TASK);
  assert.equal(sel.ok, false);
  assert.equal(sel.error, "NO_FREE_AGENT_MODEL_AVAILABLE");
});

test("ranking: frontier free model outranks weaker free models", () => {
  const r = mkRouter();
  baseModels(r);
  const ranked = r.rankCandidates(TASK);
  const ids = ranked.map((x) => x.model.id);
  assert.equal(ids[0], "z-ai/glm-5.2:free");
  assert.equal(ids[1], "google/gemma-4-31b-it:free");
  assert.equal(ids[2], "dots-studio/dots-3-note-preview:free");
  assert.equal(ids[3], "cohere/north-mini-code:free");
});

test("finishCompat=0 (north-mini-code) demotes below compatible models", () => {
  const r = mkRouter();
  baseModels(r);
  const ranked = r.rankCandidates(TASK);
  const dots = ranked.find((x) => x.model.id === "dots-studio/dots-3-note-preview:free");
  const north = ranked.find((x) => x.model.id === "cohere/north-mini-code:free");
  assert.equal(north.breakdown.reliability, 0);
  assert.ok(dots.score > north.score);
});

test("vision task excludes non-vision models", () => {
  const r = mkRouter();
  baseModels(r);
  const ranked = r.rankCandidates({ ...TASK, hasImages: true });
  assert.ok(ranked.every((x) => x.model.capabilities.vision >= 0.30));
  assert.ok(ranked.every((x) => x.model.id !== "google/gemma-4-31b-it:free"));
});

test("tool-heavy task requires tool_calling", () => {
  const r = mkRouter();
  baseModels(r);
  addModel(r, { id: "google/lyria-3-pro-preview", name: "Lyria", pricing: { input: 0, output: 0 }, free: true, context: { input: 8192, output: 8192 }, capabilities: { reasoning: 0.1, coding: 0.1, agentic: 0.1, tools: 0.05, structuredOutput: 0.1, vision: 0.1 }, finishCompat: 1 });
  const ranked = r.rankCandidates({ ...TASK, hasTools: true });
  assert.ok(ranked.every((x) => x.model.capabilities.tools >= 0.35));
  assert.ok(ranked.every((x) => x.model.id !== "google/lyria-3-pro-preview"));
});

test("429 cooldown: excluded, exponential, then eligible after expiry", () => {
  const r = mkRouter();
  baseModels(r);
  const key = "openrouter/z-ai/glm-5.2:free";
  r.recordOutcome("openrouter", "z-ai/glm-5.2:free", { type: "rate_limit", latencyMs: 100 });
  const m = r.models.get(key);
  assert.equal(m.health.state, "cooldown");
  assert.equal(m.health.cooldownUntil, NOW + 60_000);
  assert.equal(r.hardEligible(m, TASK).reason, "cooldown");

  NOW += 61_000;
  r.recordOutcome("openrouter", "z-ai/glm-5.2:free", { type: "rate_limit", latencyMs: 100 });
  assert.equal(m.health.cooldownUntil, NOW + 120_000);
  assert.equal(r.hardEligible(m, TASK).reason, "cooldown");

  NOW += 120_001;
  assert.equal(r.hardEligible(m, TASK).ok, true);
});

test("success resets health and updates learning stats", () => {
  const r = mkRouter();
  baseModels(r);
  r.recordOutcome("openrouter", "dots-studio/dots-3-note-preview:free", { type: "rate_limit", latencyMs: 100 });
  r.recordOutcome("openrouter", "dots-studio/dots-3-note-preview:free", { type: "success", latencyMs: 3000, finishReason: "stop" });
  const m = r.models.get("openrouter/dots-studio/dots-3-note-preview:free");
  assert.equal(m.health.state, "healthy");
  assert.equal(m.runtime.requests, 2);
  assert.equal(m.runtime.successes, 1);
  assert.ok(Math.abs(m.runtime.avgLatencyMs - 1550) < 1);
});

test("finish_error degrades then unavailable after 3", () => {
  const r = mkRouter();
  baseModels(r);
  const key = "openrouter/cohere/north-mini-code:free";
  for (let i = 0; i < 3; i++) r.recordOutcome("openrouter", "cohere/north-mini-code:free", { type: "finish_error", latencyMs: 100, finishReason: "complete" });
  const m = r.models.get(key);
  assert.equal(m.health.state, "unavailable");
  assert.equal(m.runtime.finishErrCount, 3);
});

test("time-decay penalty fades with age", () => {
  const r = mkRouter();
  const p = r.config.penalties.rateLimit;
  const fresh = r._decay(p.weight, NOW, p.halflifeMs);
  const aged = r._decay(p.weight, NOW - 10 * p.halflifeMs, p.halflifeMs);
  assert.ok(Math.abs(fresh - p.weight) < 1e-9);
  assert.ok(aged < p.weight * 0.001);
});

test("fallback nextCandidate excludes tried set", () => {
  const r = mkRouter();
  baseModels(r);
  const tried = new Set(["openrouter/z-ai/glm-5.2:free"]);
  const next = r.nextCandidate(TASK, tried);
  assert.equal(next.model, "google/gemma-4-31b-it:free");
});

test("exploration picks a non-top candidate when rng < rate", () => {
  const r = new FreeRouter({ clock, rng: () => 0, config: { strategy: { explorationRate: 0.10 } } });
  baseModels(r);
  const sel = r.select(TASK, { allowExploration: true });
  assert.equal(sel.ok, true);
  assert.equal(sel.explored, true);
  assert.notEqual(sel.candidate.model, sel.ranked[0].model);
});

test("provider degraded halves reliability; provider cooldown excludes", () => {
  const r = mkRouter();
  baseModels(r);
  const m = r.models.get("openrouter/z-ai/glm-5.2:free");
  const base = r.score(m, TASK).breakdown.reliability;
  r._markProvider("openrouter", "degraded", 0);
  assert.ok(Math.abs(r.score(m, TASK).breakdown.reliability - base * 0.5) < 1e-6);
  r._markProvider("openrouter", "cooldown", NOW + 60_000);
  assert.equal(r.hardEligible(m, TASK).reason, "provider-unavailable");
});

test("classifier: coder families high coding/tools; audio models low agentic", () => {
  const coder = inferCapabilities("qwen3-coder-480b", "Qwen3 Coder");
  assert.ok(coder.coding > 0.7 && coder.tools > 0.5);
  const audio = inferCapabilities("google/lyria-3-pro-preview", "Lyria audio");
  assert.ok(audio.agentic < 0.1 && audio.coding < 0.15);
});

test("stealth_similarity + contextScore: 1M-context frontier model scores highest", () => {
  const big = normalizeModel({ id: "frontier/1m", name: "Frontier 1M", pricing: { input: 0, output: 0 }, free: true, context: { input: 1_000_000, output: 65536 }, capabilities: { reasoning: 0.9, coding: 0.95, agentic: 0.9, tools: 0.9, structuredOutput: 0.9, vision: 0.5 }, finishCompat: 1 }, "openrouter");
  const small = normalizeModel({ id: "small/8b", name: "Small", pricing: { input: 0, output: 0 }, free: true, context: { input: 8192, output: 4096 }, capabilities: { reasoning: 0.4, coding: 0.4, agentic: 0.3, tools: 0.3, structuredOutput: 0.3, vision: 0 }, finishCompat: 1 }, "openrouter");
  assert.equal(contextScore(big), 1);
  assert.ok(stealthSimilarity(big) > stealthSimilarity(small));
});

test("diagnostics: winner, top10, provider health, no secret fields", () => {
  const r = mkRouter();
  baseModels(r);
  r._markProvider("deepseek", "not configured", 0);
  const d = r.diagnostics();
  assert.equal(d.currentWinner, "openrouter/z-ai/glm-5.2:free");
  assert.equal(d.top10.length, 4);
  assert.ok(d.top10[0].score >= d.top10[1].score);
  const blob = JSON.stringify(d);
  assert.ok(!/sk-/i.test(blob) && !/OPENROUTER_OX|OPENCODE_ZEN|DEEPSEEK_API/i.test(blob));
});

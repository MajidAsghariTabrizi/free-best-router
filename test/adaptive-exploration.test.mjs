// DETERMINISTIC SMART-EXPLORATION TESTS
// No network, no secrets. Uses injected clock/rng — fully deterministic.
// Proves: best-model dominance + controlled exploration + learning + cooldown
//         differentiation + recovery + provider isolation + bounded failover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeModel } from "../src/classify.mjs";
import { FreeRouter } from "../src/engine.mjs";

let NOW = 1_000_000;
const clock = () => NOW;
const mkRouter = (overrides = {}) => new FreeRouter({ clock, rng: () => 0.99, ...overrides });

function addModel(router, id, { free = true, caps = null, provider = "openrouter", ctx = 262144 } = {}) {
  const raw = {
    id,
    name: id,
    pricing: free ? { input: 0, output: 0 } : { input: 0.27, output: 1.1 },
    free,
    context: { input: ctx, output: 8192 },
    capabilities: caps,
    finishCompat: 1,
  };
  const m = normalizeModel(raw, provider);
  router.models.set(router.modelKey(provider, id), m);
  return m;
}

const STRONG = { reasoning: 0.9, coding: 0.95, agentic: 0.9, tools: 0.9, structuredOutput: 0.9, vision: 0.5 };
const GOOD = { reasoning: 0.8, coding: 0.85, agentic: 0.8, tools: 0.8, structuredOutput: 0.75, vision: 0.4 };
const MID = { reasoning: 0.55, coding: 0.6, agentic: 0.5, tools: 0.5, structuredOutput: 0.5, vision: 0.15 };
const WEAK = { reasoning: 0.3, coding: 0.35, agentic: 0.3, tools: 0.3, structuredOutput: 0.3, vision: 0.05 };

function seeded(router) {
  addModel(router, "incumbent:free", { caps: STRONG });
  addModel(router, "runner-up:free", { caps: GOOD });
  addModel(router, "mid:free", { caps: MID });
  addModel(router, "weak:free", { caps: WEAK });
}

const TASK = { purpose: "coding-agent", hasTools: false, hasImages: false, hasStructured: false, largeContext: false };

test("incumbent with strong history wins by a wide margin", () => {
  const r = mkRouter();
  seeded(r);
  // give incumbent deep success history
  for (let i = 0; i < 50; i++) r.recordOutcome("openrouter", "incumbent:free", { type: "success", latencyMs: 500, finishReason: "stop" });
  const sel = r.select(TASK);
  assert.equal(sel.ok, true);
  assert.equal(sel.candidate.model, "incumbent:free");
  assert.ok(sel.ranked[0].score - sel.ranked[1].score > 0.05);
});

test("exploration fires on cold pool to discover runner-up", () => {
  const r = new FreeRouter({ clock, rng: () => 0.0, config: { strategy: { explorationRate: 0.20, exploreGap: 0.15, explorePoolMax: 4, minSamples: 5 } } });
  seeded(r);
  // No history at all
  let exploredCount = 0;
  for (let i = 0; i < 50; i++) {
    const sel = r.select(TASK, { allowExploration: true });
    if (sel.explored) exploredCount++;
  }
  // rng=0 is always < 0.20 rate, so every call should explore when pool>=2
  assert.ok(exploredCount >= 40, `expected most calls to explore, got ${exploredCount}`);
});

test("under-sampled candidate gets explored preferentially over stable high-score rival", () => {
  const r = new FreeRouter({ clock, rng: () => 0.0, config: { strategy: { explorationRate: 1.0, exploreGap: 0.20, explorePoolMax: 4, minSamples: 5 } } });
  // Two strong candidates
  addModel(r, "stable:free", { caps: STRONG });
  addModel(r, "fresh:free", { caps: STRONG });
  // Give stable 200 successes (high Wilson)
  for (let i = 0; i < 200; i++) r.recordOutcome("openrouter", "stable:free", { type: "success", latencyMs: 800, finishReason: "stop" });
  // fresh is unknown (0 samples)
  const exploredChoices = new Set();
  for (let i = 0; i < 10; i++) {
    const sel = r.select(TASK, { allowExploration: true });
    if (sel.explored) exploredChoices.add(sel.candidate.model);
  }
  assert.ok(exploredChoices.has("fresh:free"), "fresh under-sampled candidate should be explored");
});

test("cooldown: a model that failed 429 is NOT a valid exploration target", () => {
  const r = new FreeRouter({ clock, rng: () => 0.0, config: { strategy: { explorationRate: 1.0, exploreGap: 0.20, explorePoolMax: 4, minSamples: 5 } } });
  seeded(r);
  // Cool down runner-up
  r.recordOutcome("openrouter", "runner-up:free", { type: "rate_limit", latencyMs: 100 });
  for (let i = 0; i < 30; i++) {
    const sel = r.select(TASK, { allowExploration: true });
    if (sel.explored) {
      assert.notEqual(sel.candidate.model, "runner-up:free", "exploration must never pick a cooldown model");
    }
  }
});

test("recovery: after cooldown expiry the model returns to the ranked list", () => {
  const r = mkRouter();
  seeded(r);
  r.recordOutcome("openrouter", "runner-up:free", { type: "rate_limit", latencyMs: 100 });
  // pool still has 3
  let sel = r.select(TASK);
  assert.equal(sel.ok, true);
  // advance past 60s cooldown
  NOW += 70_000;
  sel = r.select(TASK);
  assert.ok(sel.ranked.some((c) => c.model === "runner-up:free"), "runner-up returns after cooldown");
});

test("exploration pool respects the explorePoolMax cap", () => {
  const r = new FreeRouter({ clock, rng: () => 0.0, config: { strategy: { explorationRate: 1.0, exploreGap: 0.5, explorePoolMax: 2, minSamples: 5 } } });
  // 1 strong incumbent + 4 near-equal rivals
  addModel(r, "incumbent:free", { caps: STRONG });
  for (let i = 0; i < 4; i++) addModel(r, `rival-${i}:free`, { caps: STRONG });
  const choices = new Set();
  for (let i = 0; i < 20; i++) {
    const sel = r.select(TASK, { allowExploration: true });
    if (sel.explored) choices.add(sel.candidate.model);
  }
  assert.ok(choices.size <= 2, `explorePoolMax=2 should cap choices, got ${choices.size}`);
});

test("provider isolation: a healthy provider still serves traffic while a peer is degraded", () => {
  const r = mkRouter();
  addModel(r, "a-model:free", { caps: STRONG, provider: "provA" });
  addModel(r, "b-model:free", { caps: STRONG, provider: "provB" });
  r._markProvider("provA", "degraded", 0);
  // pick 20 times, all must come from provB
  for (let i = 0; i < 20; i++) {
    const sel = r.select(TASK);
    assert.equal(sel.candidate.provider, "provB");
  }
});

test("bounded failover: pool exhaustion returns NO_FREE_AGENT_MODEL_AVAILABLE", () => {
  const r = mkRouter();
  addModel(r, "x:free", { caps: STRONG, provider: "provA" });
  r._markProvider("provA", "unavailable", NOW + 600_000);
  const sel = r.select(TASK);
  assert.equal(sel.ok, false);
  assert.equal(sel.error, "NO_FREE_AGENT_MODEL_AVAILABLE");
});

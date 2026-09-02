// multi-provider.test.mjs
// Deterministic tests for multi-provider routing: Groq, Cerebras, Mistral, OpenRouter.
// Proves: provider-agnostic catalog, cross-provider failover, free-only guarantee,
// provider health, exploration crossing provider boundaries, no duplicates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FreeRouter } from "../src/engine.mjs";

let NOW = 1_000_000;
const clock = () => NOW;
const mkRouter = (adapters = []) => new FreeRouter({ clock, rng: () => 0.99, adapters });

// Minimal mock adapter with canned discover + execute
function mockAdapter(id, models = [], reachable = true) {
  return {
    id,
    displayName: id,
    configured: () => true,
    dataPolicy: {},
    async discoverModels() { return models; },
    async healthCheck() { return { reachable }; },
    async execute({ model, body, signal }) {
      const found = models.find((m) => m.id === model);
      if (!found) return { ok: false, status: 404, text: async () => "not found" };
      if (found._fail) return { ok: false, status: found._fail, text: async () => "" };
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }] }),
      };
    },
  };
}

function raw(id, provider, free = true) {
  return { id, name: id, provider, pricing: free ? { input: 0, output: 0 } : { input: 1, output: 1 }, free, context: { input: 128000, output: 8192 }, capabilities: { reasoning: 0.7, coding: 0.7, agentic: 0.7, tools: 0.7, structuredOutput: 0.7, vision: 0 } };
}

const TASK = { purpose: "coding-agent", hasTools: false, hasImages: false, hasStructured: false, largeContext: false };

// ---- TEST 1: Multiple providers discovered ----------------------------------------
test("1. multiple providers populate the catalog independently", async () => {
  const groqA = mockAdapter("groq", [
    raw("llama-3.3-70b-versatile", "groq"),
    raw("qwen-2.5-32b", "groq"),
  ]);
  const cerebrasA = mockAdapter("cerebras", [
    raw("llama-3.3-70b", "cerebras"),
    raw("qwen-2.5-coder-32b", "cerebras"),
  ]);
  const openrouterA = mockAdapter("openrouter", [
    raw("minimax-m3:free", "openrouter"),
  ]);
  const router = mkRouter([groqA, cerebrasA, openrouterA]);
  await router.refreshCatalogs({ force: true });

  const keys = [...router.models.keys()];
  assert.ok(keys.some((k) => k.startsWith("groq/")), "groq models present");
  assert.ok(keys.some((k) => k.startsWith("cerebras/")), "cerebras models present");
  assert.ok(keys.some((k) => k.startsWith("openrouter/")), "openrouter models present");
  assert.equal(keys.length, 5, "no duplicates");
});

// ---- TEST 2: Free models normalised correctly ------------------------------------
test("2. free models from any provider are marked free", async () => {
  const r = mkRouter([
    mockAdapter("groq", [raw("llama-3.3-70b-versatile", "groq", true)]),
    mockAdapter("cerebras", [raw("llama-3.3-70b", "cerebras", true)]),
    mockAdapter("mistral", [raw("mistral-small-latest", "mistral", true)]),
  ]);
  await r.refreshCatalogs({ force: true });
  for (const m of r.models.values()) {
    assert.equal(m.free, true, `${m.id} from ${m.provider} must be free`);
  }
});

// ---- TEST 3: Paid models rejected ------------------------------------------------
test("3. paid models from any provider are excluded from routing", async () => {
  const r = mkRouter([
    mockAdapter("groq", [
      raw("llama-3.3-70b-versatile", "groq", true),
      raw("gpt-4o", "groq", false),
    ]),
    mockAdapter("cerebras", [
      raw("qwen-2.5-32b", "cerebras", true),
      raw("claude-3.5", "cerebras", false),
    ]),
  ]);
  await r.refreshCatalogs({ force: true });
  const sel = r.select(TASK);
  assert.notEqual(sel.candidate.model, "gpt-4o");
  assert.notEqual(sel.candidate.model, "claude-3.5");
  assert.equal(sel.ok, true);
});

// ---- TEST 4: Provider A healthy → Provider A model selected ----------------------
test("4. healthy provider model is selected before unhealthy provider", async () => {
  const provA = mockAdapter("providerA", [
    { ...raw("model-A1", "providerA"), capabilities: { reasoning: 0.85, coding: 0.85, agentic: 0.85, tools: 0.85, structuredOutput: 0.8, vision: 0 } },
    { ...raw("model-A2", "providerA"), capabilities: { reasoning: 0.80, coding: 0.80, agentic: 0.80, tools: 0.80, structuredOutput: 0.8, vision: 0 } },
  ]);
  const provB = mockAdapter("providerB", [
    { ...raw("model-B1", "providerB"), capabilities: { reasoning: 0.70, coding: 0.70, agentic: 0.70, tools: 0.70, structuredOutput: 0.7, vision: 0 } },
  ]);
  const r = mkRouter([provA, provB]);
  await r.refreshCatalogs({ force: true });

  const sel = r.select(TASK);
  assert.equal(sel.ok, true);
  assert.ok(sel.candidate.model.startsWith("model-A"), "top model must be from provider A (stronger caps)");
  assert.equal(sel.candidate.provider, "providerA");
});

// ---- TEST 5: Provider A 429 → Provider B selected ----------------------------------
test("5. 429 on Provider A rotates to Provider B", async () => {
  const provA = mockAdapter("provA", [
    { ...raw("model-A", "provA"), capabilities: { reasoning: 0.85, coding: 0.85, agentic: 0.85, tools: 0.85, structuredOutput: 0.8, vision: 0 } },
  ]);
  const provB = mockAdapter("provB", [
    { ...raw("model-B", "provB"), capabilities: { reasoning: 0.78, coding: 0.78, agentic: 0.78, tools: 0.78, structuredOutput: 0.75, vision: 0 } },
  ]);
  const r = mkRouter([provA, provB]);
  await r.refreshCatalogs({ force: true });

  r.recordOutcome("provA", "model-A", { type: "rate_limit", latencyMs: 50 });

  const sel = r.select(TASK);
  assert.equal(sel.ok, true);
  assert.equal(sel.candidate.provider, "provB");
  assert.equal(sel.candidate.model, "model-B");
});

// ---- TEST 6: Provider A timeout → Provider B selected ------------------------------
test("6. timeout on Provider A rotates to Provider B", async () => {
  const provA = mockAdapter("provA", [
    { ...raw("model-A", "provA"), capabilities: { reasoning: 0.85, coding: 0.85, agentic: 0.85, tools: 0.85, structuredOutput: 0.8, vision: 0 } },
  ]);
  const provB = mockAdapter("provB", [
    { ...raw("model-B", "provB"), capabilities: { reasoning: 0.78, coding: 0.78, agentic: 0.78, tools: 0.78, structuredOutput: 0.75, vision: 0 } },
  ]);
  const r = mkRouter([provA, provB]);
  await r.refreshCatalogs({ force: true });

  r.recordOutcome("provA", "model-A", { type: "timeout", latencyMs: 30000 });

  const sel = r.select(TASK);
  assert.equal(sel.ok, true);
  assert.equal(sel.candidate.provider, "provB");
  assert.equal(sel.candidate.model, "model-B");
});

// ---- TEST 7: Provider A completely unavailable → Provider B selected ---------------
test("7. unavailable provider is excluded from selection", async () => {
  const provA = mockAdapter("provA", [
    { ...raw("model-A", "provA"), capabilities: { reasoning: 0.85, coding: 0.85, agentic: 0.85, tools: 0.85, structuredOutput: 0.8, vision: 0 } },
  ]);
  const provB = mockAdapter("provB", [
    { ...raw("model-B", "provB"), capabilities: { reasoning: 0.78, coding: 0.78, agentic: 0.78, tools: 0.78, structuredOutput: 0.75, vision: 0 } },
  ]);
  const r = mkRouter([provA, provB]);
  await r.refreshCatalogs({ force: true });

  r._markProvider("provA", "unavailable", NOW + 600_000);

  const sel = r.select(TASK);
  assert.equal(sel.ok, true);
  assert.equal(sel.candidate.provider, "provB");
});

// ---- TEST 8: Exploration crosses provider boundaries --------------------------------
test("8. exploration selects from a different provider than the incumbent", async () => {
  const provA = mockAdapter("provA", [
    { ...raw("incumbent-A", "provA"), capabilities: { reasoning: 0.9, coding: 0.9, agentic: 0.9, tools: 0.9, structuredOutput: 0.85, vision: 0 } },
  ]);
  const provB = mockAdapter("provB", [
    { ...raw("candidate-B", "provB"), capabilities: { reasoning: 0.8, coding: 0.8, agentic: 0.8, tools: 0.8, structuredOutput: 0.78, vision: 0 } },
  ]);
  const r = new FreeRouter({ clock, rng: () => 0.0, adapters: [provA, provB] });
  await r.refreshCatalogs({ force: true });
  for (let i = 0; i < 20; i++) r.recordOutcome("provA", "incumbent-A", { type: "success", latencyMs: 500 });

  const sel = r.select(TASK);
  assert.equal(sel.explored, true);
  assert.equal(sel.candidate.provider, "provB", "exploration must cross provider boundary");
  assert.equal(sel.candidate.model, "candidate-B");
});

// ---- TEST 9: No duplicate models --------------------------------------------------
test("9. same model id from different providers produces separate catalog entries", async () => {
  const provA = mockAdapter("provA", [raw("shared-model", "provA", true)]);
  const provB = mockAdapter("provB", [raw("shared-model", "provB", true)]);
  const r = mkRouter([provA, provB]);
  await r.refreshCatalogs({ force: true });

  assert.ok(r.models.has("provA/shared-model"), "provA/shared-model exists");
  assert.ok(r.models.has("provB/shared-model"), "provB/shared-model exists");
  assert.notEqual(r.models.get("provA/shared-model"), r.models.get("provB/shared-model"));
  assert.equal(r.models.size, 2);
});

// ---- TEST 10: No paid fallback ---------------------------------------------------
test("10. paid model is never selected regardless of provider", async () => {
  const provA = mockAdapter("provA", [
    { ...raw("free-A", "provA", true), capabilities: { reasoning: 0.5, coding: 0.5, agentic: 0.5, tools: 0.5, structuredOutput: 0.5, vision: 0 } },
    { ...raw("paid-A", "provA", false), capabilities: { reasoning: 0.95, coding: 0.95, agentic: 0.95, tools: 0.95, structuredOutput: 0.9, vision: 0 } },
  ]);
  const provB = mockAdapter("provB", [
    { ...raw("free-B", "provB", true), capabilities: { reasoning: 0.5, coding: 0.5, agentic: 0.5, tools: 0.5, structuredOutput: 0.5, vision: 0 } },
    { ...raw("paid-B", "provB", false), capabilities: { reasoning: 0.95, coding: 0.95, agentic: 0.95, tools: 0.95, structuredOutput: 0.9, vision: 0 } },
  ]);
  const r = mkRouter([provA, provB]);
  await r.refreshCatalogs({ force: true });

  for (let i = 0; i < 50; i++) {
    const sel = r.select(TASK);
    assert.ok(sel.ok);
    assert.equal(sel.candidate.model.startsWith("paid-"), false, "paid model must never be selected");
  }
});

// ---- TEST 11: Provider cooldown works -------------------------------------------
test("11. provider-level cooldown excludes all its models", async () => {
  const provA = mockAdapter("provA", [
    { ...raw("model-A1", "provA"), capabilities: { reasoning: 0.85, coding: 0.85, agentic: 0.85, tools: 0.85, structuredOutput: 0.8, vision: 0 } },
    { ...raw("model-A2", "provA"), capabilities: { reasoning: 0.82, coding: 0.82, agentic: 0.82, tools: 0.82, structuredOutput: 0.8, vision: 0 } },
  ]);
  const provB = mockAdapter("provB", [
    { ...raw("model-B1", "provB"), capabilities: { reasoning: 0.78, coding: 0.78, agentic: 0.78, tools: 0.78, structuredOutput: 0.75, vision: 0 } },
  ]);
  const r = mkRouter([provA, provB]);
  await r.refreshCatalogs({ force: true });

  r._markProvider("provA", "cooldown", NOW + 120_000);

  const sel = r.select(TASK);
  assert.equal(sel.ok, true);
  assert.equal(sel.candidate.provider, "provB");

  const ranked = sel.ranked;
  assert.ok(ranked.every((c) => c.model.provider !== "provA"), "no provA models in ranked");
});

// ---- TEST 12: Model cooldown works -----------------------------------------------
test("12. cooldown model is excluded, others remain eligible", async () => {
  const provA = mockAdapter("provA", [
    { ...raw("model-A1", "provA"), capabilities: { reasoning: 0.85, coding: 0.85, agentic: 0.85, tools: 0.85, structuredOutput: 0.8, vision: 0 } },
    { ...raw("model-A2", "provA"), capabilities: { reasoning: 0.78, coding: 0.78, agentic: 0.78, tools: 0.78, structuredOutput: 0.75, vision: 0 } },
  ]);
  const r = mkRouter([provA]);
  await r.refreshCatalogs({ force: true });
  for (let i = 0; i < 100; i++) r.recordOutcome("provA", "model-A1", { type: "success", latencyMs: 100 });
  for (let i = 0; i < 5; i++) r.recordOutcome("provA", "model-A2", { type: "success", latencyMs: 100 });

  const m = r.models.get("provA/model-A1");
  m.health.state = "cooldown";
  m.health.cooldownUntil = NOW + 60_000;
  assert.equal(m.health.state, "cooldown");

  const sel = r.select(TASK);
  assert.equal(sel.ok, true);
  assert.equal(sel.candidate.model, "model-A2", "during cooldown A2 wins");

  NOW += 61_000;
  const sel2 = r.select(TASK);
  assert.equal(sel2.candidate.model, "model-A1", "after recovery A1 reclaims #1");
});

// ---- TEST 13: Catalog refresh works (discovers new models) ------------------------
test("13. catalog refresh adds new models and updates existing ones", async () => {
  const provA = mockAdapter("provA", [
    { ...raw("model-A1", "provA"), capabilities: { reasoning: 0.85, coding: 0.85, agentic: 0.85, tools: 0.85, structuredOutput: 0.8, vision: 0 } },
  ]);
  const r = mkRouter([provA]);
  await r.refreshCatalogs({ force: true });
  assert.ok(r.models.has("provA/model-A1"), "initial model discovered");
  const initialCount = r.models.size;

  provA.discoverModels = async () => [
    { ...raw("model-A1", "provA"), capabilities: { reasoning: 0.85, coding: 0.85, agentic: 0.85, tools: 0.85, structuredOutput: 0.8, vision: 0 } },
    { ...raw("model-A2", "provA"), capabilities: { reasoning: 0.80, coding: 0.80, agentic: 0.80, tools: 0.80, structuredOutput: 0.78, vision: 0 } },
  ];

  await r.refreshCatalogs({ force: true });
  assert.ok(r.models.has("provA/model-A1"), "existing model preserved");
  assert.ok(r.models.has("provA/model-A2"), "new model discovered");
  assert.equal(r.models.size, initialCount + 1);
  assert.ok(r.lastCatalogRefresh.get("provA") >= NOW, "catalog refresh timestamp updated");
});

// ---- TEST 14: All providers unavailable → bounded failure -----------------------
test("14. all candidates unavailable returns bounded NO_FREE_AGENT_MODEL_AVAILABLE", async () => {
  const provA = mockAdapter("provA", [
    { ...raw("model-A1", "provA"), capabilities: { reasoning: 0.85, coding: 0.85, agentic: 0.85, tools: 0.85, structuredOutput: 0.8, vision: 0 } },
    { ...raw("model-A2", "provA"), capabilities: { reasoning: 0.78, coding: 0.78, agentic: 0.78, tools: 0.78, structuredOutput: 0.75, vision: 0 } },
  ]);
  const r = mkRouter([provA]);
  await r.refreshCatalogs({ force: true });

  for (let i = 0; i < 3; i++) r.recordOutcome("provA", "model-A1", { type: "rate_limit", latencyMs: 50 });
  for (let i = 0; i < 3; i++) r.recordOutcome("provA", "model-A2", { type: "rate_limit", latencyMs: 50 });

  const tried = new Set();
  let attempts = 0;
  for (let a = 0; a < 10; a++) {
    const sel = r.select(TASK, { exclude: tried, allowExploration: false });
    if (!sel.ok) break;
    tried.add(r.modelKey(sel.candidate.provider, sel.candidate.model));
    attempts++;
    if (attempts >= r.config.fallback.maxDepth) break;
  }
  assert.ok(attempts <= r.config.fallback.maxDepth, "must not exceed maxDepth");
  const selFinal = r.select(TASK, { exclude: tried, allowExploration: false });
  assert.equal(selFinal.ok, false);
  assert.equal(selFinal.error, "NO_FREE_AGENT_MODEL_AVAILABLE");
});
